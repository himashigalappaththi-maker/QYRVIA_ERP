-- ============================================================================
-- phase66a_ari_outbox_worker_resolver_bootstrap.sql
-- Phase 66A-B2N-D — ADDITIVE bootstrap: the ARI outbox tenant resolver
-- ============================================================================
-- PRIVILEGE REQUIRED: PostgreSQL SUPERUSER.
-- DO NOT RUN VIA THE MIGRATION RUNNER. Run this once as a DBA/operator, BEFORE
-- migration 0089, on every database instance that ALREADY ran the two-function
-- version of phase66a_worker_resolvers_bootstrap.sql.
-- The application runtime role must NEVER run this script.
-- It must NEVER be run automatically — not by a boot hook, not by a test, not
-- by CI, not by the migration runner.
--
-- WHICH SCRIPT DO I RUN?
-- ──────────────────────
--   FRESH environment (worker_resolvers does not exist yet)
--     -> run scripts/db/phase66a_worker_resolvers_bootstrap.sql ONLY.
--        It now installs all three resolvers in one pass. Do NOT then run this
--        script: it would be a redundant no-op at best.
--
--   EXISTING environment (worker_resolvers already holds the two Phase 66A-B2F
--   resolvers, installed before Phase 66A-B2N-D existed)
--     -> run THIS script ONLY. Do NOT re-run the original bootstrap. Re-running
--        it is not dangerous, but it is unnecessary work against a live
--        database and this project has already decided against it.
--
-- WHY THIS SCRIPT EXISTS AT ALL
-- ─────────────────────────────
-- ari_outbox_store (migrations 0087/0088) is ENABLE + FORCE ROW LEVEL SECURITY.
-- A global ARI outbox drain worker therefore cannot discover which tenants have
-- work: with no tenant bound it sees zero rows, and "no rows" is
-- indistinguishable from "nothing to do". The fix must come from a role exempt
-- from RLS.
--
-- This script creates NO such role. It REUSES the existing Phase 62 role
-- qyrvia_auth_resolver, which is already NOLOGIN + BYPASSRLS and already owns
-- the auth_resolvers and worker_resolvers SECURITY DEFINER functions. Ownership
-- cannot be assigned by the migration runner — PostgreSQL refuses with 42501
-- "must be able to SET ROLE" because the runtime role is deliberately not a
-- member of that role — hence this separate superuser step, exactly as Phase
-- 62A and Phase 66A-B2F established.
--
-- WHAT THIS CREATES
-- ─────────────────
-- 1. worker_resolvers.due_ari_outbox_tenants(integer) — owned by
--    qyrvia_auth_resolver, SECURITY DEFINER, STABLE
-- 2. EXECUTE grant on that ONE function → APP_ROLE
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ──────────────────────────────────
-- * It creates NO role and alters NO role attribute.
-- * It grants NO role membership and NO BYPASSRLS to anything.
-- * It grants the runtime role NO table access of any kind. The column-level
--   SELECT grants on public.ari_outbox_store belong to migration 0089, which
--   runs as the ordinary application role that owns the table.
-- * It does not create, replace, alter, re-grant or drop
--   pending_channel_tenants or due_scheduler_tenants. Those two are read as a
--   prerequisite and then left completely alone.
-- * It does not create or alter the worker_resolvers schema, or change its
--   ownership. The schema must already exist.
-- * It does not touch RLS, FORCE RLS, policies or table ownership.
-- * It performs no DML and no backfill.
-- * It never repairs a role, schema or function whose configuration is
--   unexpected — it aborts instead. A bootstrap that "fixes" surprising
--   privilege state is a privilege-escalation tool wearing a helpful hat.
--
-- FUNCTION DEFINITION PARITY
-- ──────────────────────────
-- The CREATE OR REPLACE block below is byte-identical to the one in
-- phase66a_worker_resolvers_bootstrap.sql. A static contract test
-- (server/test/phase66a_worker_resolvers_bootstrap_contract.test.js) asserts
-- that parity, so the two scripts cannot drift into installing different
-- functions in different environments.
--
-- USAGE
-- ─────
--   psql "<CONNECTION_URL_WITH_SUPERUSER>" \
--       --set APP_ROLE=<application_login_role> \
--       --single-transaction \
--       -f scripts/db/phase66a_ari_outbox_worker_resolver_bootstrap.sql
--
-- (Supply the connection string from your own secret store. This file contains
--  no credentials and no connection string, by design.)
--
-- IDEMPOTENCE
-- ───────────
-- Safe to run once, and safe to re-run as an idempotent verification/
-- replacement pass. CREATE OR REPLACE FUNCTION, REVOKE and GRANT are all
-- idempotent, and every re-run re-asserts the full security contract (step 6)
-- and aborts if anything has drifted.
--
-- ROLLBACK / RECOVERY
-- ───────────────────
-- The whole script runs in one transaction; any assertion failure rolls
-- everything back atomically, leaving no partial function and no partial grant.
-- To remove ONLY what this script added, as superuser, and only after
-- confirming no worker depends on it:
--   DROP FUNCTION worker_resolvers.due_ari_outbox_tenants(integer);
-- The schema, the other two resolvers and the Phase 62 roles must be left in
-- place; other infrastructure depends on them.
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
  v_rec     record;
  v_owner   text;
  v_count   int;
  v_missing text;
BEGIN
  -- 1a. Superuser only. SET LOCAL ROLE to the function owner (step 3) is
  --     impossible otherwise, and we must not silently produce a function
  --     owned by the wrong role — such a function would be SECURITY DEFINER
  --     without BYPASSRLS, would return zero rows forever under FORCE RLS,
  --     and the worker would report a healthy idle tick while nothing drains.
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION
      'phase66a ARI outbox resolver bootstrap must be run as a PostgreSQL superuser. '
      'Current role is not superuser.';
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

  -- 1c. The worker_resolvers schema must already exist, owned by the
  --     NON-bypassrls role. This script never creates or seizes it.
  SELECT r.rolname INTO v_owner
    FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
   WHERE n.nspname = 'worker_resolvers';
  IF v_owner IS NULL THEN
    RAISE EXCEPTION
      'Prerequisite not met: schema worker_resolvers does not exist. This is the '
      'ADDITIVE bootstrap for an environment that already ran '
      'phase66a_worker_resolvers_bootstrap.sql. On a fresh environment run that '
      'script instead — it installs all three resolvers.';
  END IF;
  IF v_owner <> 'qyrvia_auth_schema_owner' THEN
    RAISE EXCEPTION
      'Schema worker_resolvers is owned by %, expected qyrvia_auth_schema_owner. '
      'Refusing to install into an unexpected schema. Investigate before '
      're-running.', v_owner;
  END IF;

  -- 1d. Both original resolvers must already be present.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers'
     AND p.proname IN ('pending_channel_tenants', 'due_scheduler_tenants');
  IF v_count <> 2 THEN
    RAISE EXCEPTION
      'Prerequisite not met: expected both original worker resolvers to exist, '
      'found % of 2. Run phase66a_worker_resolvers_bootstrap.sql first.', v_count;
  END IF;

  -- 1e. Nothing unapproved may already live in this schema.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers'
     AND p.proname NOT IN ('pending_channel_tenants', 'due_scheduler_tenants',
                           'due_ari_outbox_tenants');
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'Schema worker_resolvers contains % unapproved function(s). Refusing to '
      'proceed. Nothing is dropped automatically.', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'worker_resolvers';
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'Schema worker_resolvers contains % unapproved relation(s) (tables, views '
      'or similar). Refusing to proceed. Nothing is dropped automatically.', v_count;
  END IF;

  -- 1f. The source table must exist and be FORCE-RLS. If it is not, the premise
  --     of this whole design is wrong and we must not proceed.
  SELECT c.relrowsecurity, c.relforcerowsecurity INTO v_rec
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'ari_outbox_store';
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Prerequisite not met: public.ari_outbox_store does not exist. Apply '
      'migrations through 0088 first.';
  END IF;
  IF NOT v_rec.relrowsecurity THEN
    RAISE EXCEPTION
      'Prerequisite not met: public.ari_outbox_store does not have ROW LEVEL SECURITY enabled.';
  END IF;
  IF NOT v_rec.relforcerowsecurity THEN
    RAISE EXCEPTION
      'Prerequisite not met: public.ari_outbox_store does not have FORCE ROW LEVEL SECURITY.';
  END IF;

  -- 1g. Every column the resolver reads must exist. Guessing a column name here
  --     would produce a function that silently returns nothing.
  v_missing := '';
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='ari_outbox_store'
                    AND column_name='tenant_id')     THEN v_missing := v_missing || ' ari_outbox_store.tenant_id'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='ari_outbox_store'
                    AND column_name='status')        THEN v_missing := v_missing || ' ari_outbox_store.status'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='ari_outbox_store'
                    AND column_name='retry_count')   THEN v_missing := v_missing || ' ari_outbox_store.retry_count'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='ari_outbox_store'
                    AND column_name='max_retries')   THEN v_missing := v_missing || ' ari_outbox_store.max_retries'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='ari_outbox_store'
                    AND column_name='next_retry_at') THEN v_missing := v_missing || ' ari_outbox_store.next_retry_at'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='ari_outbox_store'
                    AND column_name='lease_until')   THEN v_missing := v_missing || ' ari_outbox_store.lease_until'; END IF;
  IF v_missing <> '' THEN
    RAISE EXCEPTION 'Prerequisite not met: missing expected column(s):%', v_missing;
  END IF;
END;
$$;

-- ── 2. Temporary CREATE for the function owner (revoked in step 4) ──────────
GRANT USAGE  ON SCHEMA worker_resolvers TO qyrvia_auth_resolver;
GRANT CREATE ON SCHEMA worker_resolvers TO qyrvia_auth_resolver;

-- ── 3. Create the resolver AS the function owner ────────────────────────────
--    A function created under this role is OWNED by qyrvia_auth_resolver, which
--    holds BYPASSRLS. SECURITY DEFINER then executes it as that owner, which is
--    the only way to see across the FORCE RLS boundary. Same mechanism as
--    phase62a_auth_resolvers_bootstrap.sql and
--    phase66a_worker_resolvers_bootstrap.sql.
SET LOCAL ROLE qyrvia_auth_resolver;

CREATE OR REPLACE FUNCTION worker_resolvers.due_ari_outbox_tenants(p_limit integer)
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
  SELECT DISTINCT o.tenant_id
    FROM public.ari_outbox_store o
   WHERE (o.status = 'PENDING'
          AND o.retry_count < o.max_retries
          AND (o.next_retry_at IS NULL OR o.next_retry_at <= now()))
      OR (o.status = 'PROCESSING'
          AND o.lease_until IS NOT NULL
          AND o.lease_until <= now())
   ORDER BY o.tenant_id
   LIMIT p_limit;
END;
$$;

-- ── 4. Return to superuser and withdraw CREATE ──────────────────────────────
RESET ROLE;

REVOKE CREATE ON SCHEMA worker_resolvers FROM qyrvia_auth_resolver;

-- ── 5. Restrict EXECUTE on the NEW function only ────────────────────────────
--    The two original resolvers keep the grants they already have; this script
--    does not re-issue or alter them.
--    :"APP_ROLE" uses psql quoted-identifier substitution, so the operator's
--    value cannot inject an identifier.
REVOKE ALL ON FUNCTION worker_resolvers.due_ari_outbox_tenants(integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION worker_resolvers.due_ari_outbox_tenants(integer) TO :"APP_ROLE";

-- ── 6. Assertions — any violation rolls the whole transaction back ──────────
DO $$
DECLARE
  v_fn_count     int;
  v_extra        int;
  v_bad_owner    int;
  v_not_secdef   int;
  v_not_stable   int;
  v_bad_path     int;
  v_bad_ret      int;
  v_public_exec  int;
  v_schema_owner text;
BEGIN
  -- 6a. The new function exists exactly once with the expected signature.
  SELECT count(*) INTO v_fn_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers' AND p.proname = 'due_ari_outbox_tenants';
  IF v_fn_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 due_ari_outbox_tenants, found %', v_fn_count;
  END IF;

  -- 6b. The approved set is now exactly three, and nothing else.
  SELECT count(*) INTO v_fn_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers';
  IF v_fn_count <> 3 THEN
    RAISE EXCEPTION 'worker_resolvers holds % function(s), expected exactly 3', v_fn_count;
  END IF;

  SELECT count(*) INTO v_extra
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers'
     AND p.proname NOT IN ('pending_channel_tenants', 'due_scheduler_tenants',
                           'due_ari_outbox_tenants');
  IF v_extra > 0 THEN
    RAISE EXCEPTION 'worker_resolvers holds % unapproved function(s)', v_extra;
  END IF;

  -- 6c. Owned by the BYPASSRLS definer role.
  SELECT count(*) INTO v_bad_owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
   WHERE n.nspname = 'worker_resolvers' AND p.proname = 'due_ari_outbox_tenants'
     AND r.rolname <> 'qyrvia_auth_resolver';
  IF v_bad_owner > 0 THEN
    RAISE EXCEPTION 'due_ari_outbox_tenants is not owned by qyrvia_auth_resolver';
  END IF;

  -- 6d. SECURITY DEFINER.
  SELECT count(*) INTO v_not_secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers' AND p.proname = 'due_ari_outbox_tenants'
     AND p.prosecdef = false;
  IF v_not_secdef > 0 THEN
    RAISE EXCEPTION 'due_ari_outbox_tenants is NOT SECURITY DEFINER';
  END IF;

  -- 6e. STABLE.
  SELECT count(*) INTO v_not_stable
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers' AND p.proname = 'due_ari_outbox_tenants'
     AND p.provolatile <> 's';
  IF v_not_stable > 0 THEN
    RAISE EXCEPTION 'due_ari_outbox_tenants is NOT STABLE';
  END IF;

  -- 6f. Fixed search_path.
  SELECT count(*) INTO v_bad_path
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers' AND p.proname = 'due_ari_outbox_tenants'
     AND (p.proconfig IS NULL
          OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg
                          WHERE cfg LIKE 'search\_path=%'));
  IF v_bad_path > 0 THEN
    RAISE EXCEPTION 'due_ari_outbox_tenants has no fixed search_path';
  END IF;

  -- 6g. Returns exactly one uuid column named tenant_id.
  SELECT count(*) INTO v_bad_ret
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers' AND p.proname = 'due_ari_outbox_tenants'
     AND (p.proretset = false
          OR array_length(p.proargnames, 1) IS DISTINCT FROM 2
          OR p.proargnames[2] <> 'tenant_id');
  IF v_bad_ret > 0 THEN
    RAISE EXCEPTION 'due_ari_outbox_tenants does not return exactly TABLE(tenant_id uuid)';
  END IF;

  -- 6h. PUBLIC has no EXECUTE on anything in this schema.
  SELECT count(*) INTO v_public_exec
    FROM information_schema.routine_privileges rp
   WHERE rp.routine_schema = 'worker_resolvers'
     AND rp.privilege_type = 'EXECUTE'
     AND rp.grantee        = 'PUBLIC';
  IF v_public_exec > 0 THEN
    RAISE EXCEPTION 'PUBLIC has EXECUTE on % worker resolver function(s) — expected zero',
                    v_public_exec;
  END IF;

  -- 6i. Schema ownership is unchanged by this script.
  SELECT r.rolname INTO v_schema_owner
    FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
   WHERE n.nspname = 'worker_resolvers';
  IF v_schema_owner IS DISTINCT FROM 'qyrvia_auth_schema_owner' THEN
    RAISE EXCEPTION 'worker_resolvers schema owner is %, expected qyrvia_auth_schema_owner',
                    COALESCE(v_schema_owner, '<null>');
  END IF;

  -- 6j. The source table's RLS posture is untouched by this script.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'ari_outbox_store')
     OR NOT (SELECT c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'ari_outbox_store') THEN
    RAISE EXCEPTION 'ari_outbox_store lost RLS or FORCE RLS — this script must never change it';
  END IF;

  RAISE NOTICE
    'phase66a_ari_outbox_worker_resolver_bootstrap assertions PASSED: % functions, schema owner = %, no PUBLIC access',
    v_fn_count, v_schema_owner;
END;
$$;

COMMIT;
