-- ============================================================================
-- phase66a_worker_resolvers_bootstrap.sql
-- Phase 66A — Worker Resolver Infrastructure Bootstrap
-- ============================================================================
-- PRIVILEGE REQUIRED: PostgreSQL SUPERUSER.
-- DO NOT RUN VIA THE MIGRATION RUNNER. Run this once as a DBA/operator, BEFORE
-- migration 0085, on every database instance (local dev, staging, production).
-- The application runtime role must NEVER run this script.
--
-- WHY THIS SCRIPT HAS TO EXIST
-- ────────────────────────────
-- channel_sync_queue_store and scheduled_jobs are both ENABLE + FORCE ROW LEVEL
-- SECURITY, keyed on app.tenant_id. A global background worker therefore cannot
-- discover *which tenants have work* — with no tenant bound it sees zero rows,
-- and "no rows" is indistinguishable from "nothing to do". That is why the
-- outbound channel dispatcher (P0-12) and the scheduler (P0-14) both silently
-- process nothing today.
--
-- The fix has to come from a role that is exempt from RLS. This script does NOT
-- create one: it REUSES the existing Phase 62 role qyrvia_auth_resolver, which
-- is already NOLOGIN + BYPASSRLS and already owns the four auth_resolvers
-- SECURITY DEFINER functions. Ownership cannot be assigned by the migration
-- runner — PostgreSQL refuses with 42501 "must be able to SET ROLE" because the
-- runtime role is deliberately not a member of that role — hence a separate
-- superuser step, exactly as Phase 62A established.
--
-- WHAT THIS CREATES
-- ─────────────────
-- 1. worker_resolvers schema, owned by qyrvia_auth_schema_owner
--    (NOT by the BYPASSRLS role — same separation Phase 62A uses)
-- 2. worker_resolvers.pending_channel_tenants(integer) — owned by
--    qyrvia_auth_resolver, SECURITY DEFINER
-- 3. worker_resolvers.due_scheduler_tenants(integer)   — owned by
--    qyrvia_auth_resolver, SECURITY DEFINER
-- 4. EXECUTE grants on both functions → APP_ROLE
-- 5. USAGE grant on the worker_resolvers schema → APP_ROLE
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ──────────────────────────────────
-- * It creates NO role. Both privileged roles must already exist from Phase 62A.
-- * It grants NO role membership, and NO BYPASSRLS, to anything.
-- * It grants the runtime role NO direct table access of any kind.
-- * It does not touch RLS, FORCE RLS, policies or table ownership.
-- * It never repairs a role or table whose configuration is unexpected — it
--   aborts instead. A bootstrap that "fixes" surprising privilege state is a
--   privilege-escalation tool wearing a helpful hat.
--
-- WHAT BELONGS IN MIGRATION 0085 (NOT HERE)
-- ──────────────────────────────────────────
-- Column-level SELECT grants on public.channel_sync_queue_store and
-- public.scheduled_jobs → qyrvia_auth_resolver. Those run via the migration
-- runner as the application role, which OWNS those tables and can grant on them
-- without superuser. This split is not invented here: it mirrors exactly how
-- phase62a_auth_resolvers_bootstrap.sql relates to migration
-- 0083_auth_resolvers_grants.sql, which puts EXECUTE/USAGE grants in the
-- bootstrap (its header items 5 and 6) and column grants in the migration.
--
-- SECURITY INVARIANTS
-- ───────────────────
-- * Both functions return EXACTLY ONE column, tenant_id uuid. No queue id, no
--   job id, no property, no reservation, no channel, no action, no status, no
--   timing, no retry counters, no error text, no payload. A worker needs one
--   fact per tenant — "there is work here" — and anything beyond that would be
--   cross-tenant data escaping RLS through a side door.
-- * Neither function reads payload_json or scheduled_jobs.payload.
-- * No dynamic SQL. No caller-supplied identifier or predicate. The only
--   argument is an integer row cap, validated 1..1000.
-- * Fixed search_path on both functions, so a hostile schema on the caller's
--   search_path cannot shadow a table name inside a BYPASSRLS definer context.
-- * PUBLIC gets no EXECUTE and no USAGE.
-- * BYPASSRLS stays confined to qyrvia_auth_resolver, which cannot log in.
-- * :"APP_ROLE" uses psql quoted-identifier substitution, so the operator's
--   value cannot inject an identifier.
--
-- USAGE
-- ─────
--   psql "<CONNECTION_URL_WITH_SUPERUSER>" \
--       --set APP_ROLE=<application_login_role> \
--       --single-transaction \
--       -f scripts/db/phase66a_worker_resolvers_bootstrap.sql
--
-- (Supply the connection string from your own secret store. This file contains
--  no credentials and no connection string, by design.)
--
-- IDEMPOTENCE
-- ───────────
-- Safe to run once per environment and safe to re-run as a verification pass.
-- CREATE SCHEMA IF NOT EXISTS, CREATE OR REPLACE FUNCTION and GRANT are all
-- idempotent. Every re-run re-asserts the full security contract (step 8) and
-- aborts if anything has drifted.
--
-- ROLLBACK / RECOVERY
-- ───────────────────
-- The whole script runs in one transaction; any assertion failure rolls
-- everything back atomically, leaving no partial schema and no partial function.
-- To remove this infrastructure, as superuser and only after confirming no
-- worker depends on it:
--   REVOKE ALL ON SCHEMA worker_resolvers FROM <app_role>;
--   DROP FUNCTION worker_resolvers.pending_channel_tenants(integer);
--   DROP FUNCTION worker_resolvers.due_scheduler_tenants(integer);
--   DROP SCHEMA worker_resolvers;      -- deliberately WITHOUT CASCADE
-- The Phase 62 roles must be left in place; other infrastructure depends on them.
-- ============================================================================

\set ON_ERROR_STOP on

\if :{?APP_ROLE}
\else
\warn 'ERROR: APP_ROLE variable is not set.'
\warn 'Run with: psql <url> --set APP_ROLE=<application_login_role> -f <this-script>'
\quit
\endif

BEGIN;

-- ── 1. Prerequisites — fail closed, repair nothing ──────────────────────────
DO $$
DECLARE
  v_rec        record;
  v_rls        record;
  v_missing    text;
BEGIN
  -- 1a. The session must be a superuser. SET LOCAL ROLE to the function owner
  --     (step 4) is impossible otherwise, and we must not silently produce
  --     functions owned by the wrong role.
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION
      'phase66a bootstrap must be run as a PostgreSQL superuser. Current role is not superuser.';
  END IF;

  -- 1b. qyrvia_auth_resolver must already exist with the Phase 62 attributes.
  SELECT rolcanlogin, rolbypassrls, rolsuper INTO v_rec
    FROM pg_roles WHERE rolname = 'qyrvia_auth_resolver';
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Prerequisite not met: role qyrvia_auth_resolver does not exist. Run '
      'scripts/db/phase62a_auth_resolvers_bootstrap.sql first. This script '
      'creates no roles.';
  END IF;
  IF v_rec.rolcanlogin THEN
    RAISE EXCEPTION 'Prerequisite not met: qyrvia_auth_resolver must be NOLOGIN.';
  END IF;
  IF NOT v_rec.rolbypassrls THEN
    RAISE EXCEPTION
      'Prerequisite not met: qyrvia_auth_resolver must already have BYPASSRLS. '
      'This script will not grant it.';
  END IF;
  IF v_rec.rolsuper THEN
    RAISE EXCEPTION 'Prerequisite not met: qyrvia_auth_resolver must NOT be superuser.';
  END IF;

  -- 1c. qyrvia_auth_schema_owner must already exist with the Phase 62 attributes.
  SELECT rolcanlogin, rolbypassrls, rolsuper INTO v_rec
    FROM pg_roles WHERE rolname = 'qyrvia_auth_schema_owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Prerequisite not met: role qyrvia_auth_schema_owner does not exist. Run '
      'scripts/db/phase62a_auth_resolvers_bootstrap.sql first. This script '
      'creates no roles.';
  END IF;
  IF v_rec.rolcanlogin THEN
    RAISE EXCEPTION 'Prerequisite not met: qyrvia_auth_schema_owner must be NOLOGIN.';
  END IF;
  IF v_rec.rolbypassrls THEN
    RAISE EXCEPTION 'Prerequisite not met: qyrvia_auth_schema_owner must NOT have BYPASSRLS.';
  END IF;
  IF v_rec.rolsuper THEN
    RAISE EXCEPTION 'Prerequisite not met: qyrvia_auth_schema_owner must NOT be superuser.';
  END IF;

  -- 1d. Both source tables must exist and be FORCE-RLS. If they are not, the
  --     premise of this whole design is wrong and we must not proceed.
  FOR v_rls IN
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('channel_sync_queue_store', 'scheduled_jobs')
  LOOP
    IF NOT v_rls.relrowsecurity THEN
      RAISE EXCEPTION 'Prerequisite not met: public.% does not have ROW LEVEL SECURITY enabled.',
                      v_rls.relname;
    END IF;
    IF NOT v_rls.relforcerowsecurity THEN
      RAISE EXCEPTION 'Prerequisite not met: public.% does not have FORCE ROW LEVEL SECURITY.',
                      v_rls.relname;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname IN ('channel_sync_queue_store', 'scheduled_jobs')) <> 2 THEN
    RAISE EXCEPTION
      'Prerequisite not met: public.channel_sync_queue_store and public.scheduled_jobs '
      'must both exist. Apply migrations through 0084 first.';
  END IF;

  -- 1e. Every column the resolvers read must exist, with the expected enum type
  --     for the scheduler status. Guessing a column name here would produce a
  --     function that silently returns nothing.
  v_missing := '';
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='channel_sync_queue_store'
                    AND column_name='tenant_id')     THEN v_missing := v_missing || ' channel_sync_queue_store.tenant_id'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='channel_sync_queue_store'
                    AND column_name='status')        THEN v_missing := v_missing || ' channel_sync_queue_store.status'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='channel_sync_queue_store'
                    AND column_name='next_retry_at') THEN v_missing := v_missing || ' channel_sync_queue_store.next_retry_at'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='channel_sync_queue_store'
                    AND column_name='next_run_at')   THEN v_missing := v_missing || ' channel_sync_queue_store.next_run_at'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='channel_sync_queue_store'
                    AND column_name='retry_count')   THEN v_missing := v_missing || ' channel_sync_queue_store.retry_count'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='channel_sync_queue_store'
                    AND column_name='max_retries')   THEN v_missing := v_missing || ' channel_sync_queue_store.max_retries'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='scheduled_jobs'
                    AND column_name='tenant_id')     THEN v_missing := v_missing || ' scheduled_jobs.tenant_id'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='scheduled_jobs'
                    AND column_name='status')        THEN v_missing := v_missing || ' scheduled_jobs.status'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='scheduled_jobs'
                    AND column_name='run_at')        THEN v_missing := v_missing || ' scheduled_jobs.run_at'; END IF;
  IF v_missing <> '' THEN
    RAISE EXCEPTION 'Prerequisite not met: missing expected column(s):%', v_missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname='public' AND t.typname='scheduled_job_status') THEN
    RAISE EXCEPTION 'Prerequisite not met: enum public.scheduled_job_status does not exist.';
  END IF;
END;
$$;

-- ── 2. Schema — create if absent, verify if present, never seize ────────────
DO $$
DECLARE
  v_owner text;
  v_extra int;
BEGIN
  SELECT r.rolname INTO v_owner
    FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
   WHERE n.nspname = 'worker_resolvers';

  IF v_owner IS NOT NULL AND v_owner <> 'qyrvia_auth_schema_owner' THEN
    RAISE EXCEPTION
      'Schema worker_resolvers already exists but is owned by %, expected '
      'qyrvia_auth_schema_owner. Refusing to take ownership of an unexpected '
      'schema. Investigate before re-running.', v_owner;
  END IF;

  IF v_owner IS NOT NULL THEN
    -- Existing schema: it may contain ONLY the two approved functions.
    SELECT count(*) INTO v_extra
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'worker_resolvers'
       AND p.proname NOT IN ('pending_channel_tenants', 'due_scheduler_tenants');
    IF v_extra > 0 THEN
      RAISE EXCEPTION
        'Schema worker_resolvers contains % unapproved function(s). Refusing to '
        'proceed. Nothing is dropped automatically.', v_extra;
    END IF;

    SELECT count(*) INTO v_extra
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'worker_resolvers';
    IF v_extra > 0 THEN
      RAISE EXCEPTION
        'Schema worker_resolvers contains % unapproved relation(s) (tables, views '
        'or similar). Refusing to proceed. Nothing is dropped automatically.', v_extra;
    END IF;
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS worker_resolvers;
ALTER SCHEMA worker_resolvers OWNER TO qyrvia_auth_schema_owner;

-- PUBLIC must hold nothing on this schema.
REVOKE ALL ON SCHEMA worker_resolvers FROM PUBLIC;

-- ── 3. Temporary CREATE for the function owner (revoked in step 5) ──────────
GRANT USAGE  ON SCHEMA worker_resolvers TO qyrvia_auth_resolver;
GRANT CREATE ON SCHEMA worker_resolvers TO qyrvia_auth_resolver;

-- ── 4. Create the resolvers AS the function owner ───────────────────────────
--    Functions created under this role are OWNED by qyrvia_auth_resolver, which
--    holds BYPASSRLS. SECURITY DEFINER then executes them as that owner, which
--    is the only way to see across the FORCE RLS boundary. This is the same
--    mechanism phase62a_auth_resolvers_bootstrap.sql uses.
SET LOCAL ROLE qyrvia_auth_resolver;

-- 4a. Tenants that have ACTIONABLE outbound channel work.
--     Returns tenant ids and nothing else — no job id, no channel, no payload.
CREATE OR REPLACE FUNCTION worker_resolvers.pending_channel_tenants(p_limit integer)
RETURNS TABLE(tenant_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_limit IS NULL THEN
    RAISE EXCEPTION 'invalid_limit: p_limit must not be NULL';
  END IF;
  IF p_limit < 1 THEN
    RAISE EXCEPTION 'invalid_limit: p_limit must be >= 1';
  END IF;
  IF p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_limit: p_limit must be <= 1000';
  END IF;

  RETURN QUERY
  SELECT DISTINCT q.tenant_id
    FROM public.channel_sync_queue_store q
   WHERE q.status = 'PENDING'
     AND (q.next_retry_at IS NULL OR q.next_retry_at <= now())
     AND (q.next_run_at   IS NULL OR q.next_run_at   <= now())
     AND q.retry_count < q.max_retries
   ORDER BY q.tenant_id
   LIMIT p_limit;
END;
$$;

-- 4b. Tenants that have GENUINELY DUE scheduled work.
--     Returns tenant ids and nothing else — no job id, no job_type, no payload.
CREATE OR REPLACE FUNCTION worker_resolvers.due_scheduler_tenants(p_limit integer)
RETURNS TABLE(tenant_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_limit IS NULL THEN
    RAISE EXCEPTION 'invalid_limit: p_limit must not be NULL';
  END IF;
  IF p_limit < 1 THEN
    RAISE EXCEPTION 'invalid_limit: p_limit must be >= 1';
  END IF;
  IF p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_limit: p_limit must be <= 1000';
  END IF;

  RETURN QUERY
  SELECT DISTINCT j.tenant_id
    FROM public.scheduled_jobs j
   WHERE j.status = 'pending'::public.scheduled_job_status
     AND j.run_at <= now()
   ORDER BY j.tenant_id
   LIMIT p_limit;
END;
$$;

-- ── 5. Return to superuser and withdraw CREATE ──────────────────────────────
RESET ROLE;

REVOKE CREATE ON SCHEMA worker_resolvers FROM qyrvia_auth_resolver;

-- ── 6. Restrict EXECUTE: nothing for PUBLIC, EXECUTE only for APP_ROLE ──────
--    :"APP_ROLE" uses psql quoted-identifier substitution — safe against
--    identifier injection regardless of what the operator supplied.
--    This placement follows the Phase 62A precedent, whose bootstrap header
--    lists EXECUTE grants (item 5) and schema USAGE (item 6) as bootstrap work,
--    leaving column-level table grants to the companion migration.
REVOKE ALL ON FUNCTION worker_resolvers.pending_channel_tenants(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION worker_resolvers.due_scheduler_tenants(integer)   FROM PUBLIC;

GRANT EXECUTE ON FUNCTION worker_resolvers.pending_channel_tenants(integer) TO :"APP_ROLE";
GRANT EXECUTE ON FUNCTION worker_resolvers.due_scheduler_tenants(integer)   TO :"APP_ROLE";

-- ── 7. Schema USAGE for the application role (no CREATE) ────────────────────
GRANT USAGE ON SCHEMA worker_resolvers TO :"APP_ROLE";

-- ── 8. Assertions — any violation rolls the whole transaction back ──────────
DO $$
DECLARE
  v_schema_owner text;
  v_fn_count     int;
  v_bad_owner    int;
  v_not_secdef   int;
  v_not_stable   int;
  v_bad_path     int;
  v_public_exec  int;
  v_public_usage int;
  v_bad_ret      int;
  v_extra        int;
BEGIN
  -- 8a. Schema owned by the NON-bypassrls role.
  SELECT r.rolname INTO v_schema_owner
    FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
   WHERE n.nspname = 'worker_resolvers';
  IF v_schema_owner IS DISTINCT FROM 'qyrvia_auth_schema_owner' THEN
    RAISE EXCEPTION 'worker_resolvers schema owner is %, expected qyrvia_auth_schema_owner',
                    COALESCE(v_schema_owner, '<null>');
  END IF;

  -- 8b. Exactly the two approved functions, and nothing else.
  SELECT count(*) INTO v_fn_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers';
  IF v_fn_count <> 2 THEN
    RAISE EXCEPTION 'worker_resolvers holds % function(s), expected exactly 2', v_fn_count;
  END IF;

  SELECT count(*) INTO v_extra
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers'
     AND p.proname NOT IN ('pending_channel_tenants', 'due_scheduler_tenants');
  IF v_extra > 0 THEN
    RAISE EXCEPTION 'worker_resolvers holds % unapproved function(s)', v_extra;
  END IF;

  -- 8c. Both owned by the BYPASSRLS definer role.
  SELECT count(*) INTO v_bad_owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
   WHERE n.nspname = 'worker_resolvers'
     AND r.rolname <> 'qyrvia_auth_resolver';
  IF v_bad_owner > 0 THEN
    RAISE EXCEPTION '% worker resolver function(s) are not owned by qyrvia_auth_resolver',
                    v_bad_owner;
  END IF;

  -- 8d. Both SECURITY DEFINER.
  SELECT count(*) INTO v_not_secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers' AND p.prosecdef = false;
  IF v_not_secdef > 0 THEN
    RAISE EXCEPTION '% worker resolver function(s) are NOT SECURITY DEFINER', v_not_secdef;
  END IF;

  -- 8e. Both STABLE.
  SELECT count(*) INTO v_not_stable
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers' AND p.provolatile <> 's';
  IF v_not_stable > 0 THEN
    RAISE EXCEPTION '% worker resolver function(s) are NOT STABLE', v_not_stable;
  END IF;

  -- 8f. Both carry a fixed search_path.
  SELECT count(*) INTO v_bad_path
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers'
     AND (p.proconfig IS NULL
          OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg
                          WHERE cfg LIKE 'search\_path=%'));
  IF v_bad_path > 0 THEN
    RAISE EXCEPTION '% worker resolver function(s) have no fixed search_path', v_bad_path;
  END IF;

  -- 8g. Both return exactly one uuid column named tenant_id.
  SELECT count(*) INTO v_bad_ret
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers'
     AND (p.proretset = false
          OR array_length(p.proargnames, 1) IS DISTINCT FROM 2
          OR p.proargnames[2] <> 'tenant_id');
  IF v_bad_ret > 0 THEN
    RAISE EXCEPTION '% worker resolver function(s) do not return exactly TABLE(tenant_id uuid)',
                    v_bad_ret;
  END IF;

  -- 8h. PUBLIC has no EXECUTE.
  SELECT count(*) INTO v_public_exec
    FROM information_schema.routine_privileges rp
   WHERE rp.routine_schema = 'worker_resolvers'
     AND rp.privilege_type = 'EXECUTE'
     AND rp.grantee        = 'PUBLIC';
  IF v_public_exec > 0 THEN
    RAISE EXCEPTION 'PUBLIC has EXECUTE on % worker resolver function(s) — expected zero',
                    v_public_exec;
  END IF;

  -- 8i. PUBLIC has no schema privilege.
  SELECT count(*) INTO v_public_usage
    FROM pg_namespace n
   WHERE n.nspname = 'worker_resolvers'
     AND (has_schema_privilege('public', n.nspname, 'USAGE')
          OR has_schema_privilege('public', n.nspname, 'CREATE'));
  IF v_public_usage > 0 THEN
    RAISE EXCEPTION 'PUBLIC holds USAGE or CREATE on worker_resolvers — expected none';
  END IF;

  RAISE NOTICE
    'phase66a_worker_resolvers_bootstrap assertions PASSED: % functions, schema owner = %, no PUBLIC access',
    v_fn_count, v_schema_owner;
END;
$$;

COMMIT;
