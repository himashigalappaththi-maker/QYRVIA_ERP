-- QYRVIA Phase 66A (B2F) — minimum source-column grants for the worker-resolver
-- functions.
--
-- PREREQUISITE
-- ────────────
-- scripts/db/phase66a_worker_resolvers_bootstrap.sql must be run by a
-- superuser BEFORE this migration is applied. That script creates:
--   - schema worker_resolvers (owned by the auth-resolver schema-owner role)
--   - 2 SECURITY DEFINER resolver functions owned by the auth-resolver role
--   - EXECUTE grants on those functions to the application login role (APP_ROLE)
--   - USAGE grant on worker_resolvers schema to APP_ROLE
--
-- WHY THIS SPLIT
-- ──────────────
-- The bootstrap requires a superuser; these column grants do not. The
-- application role (which runs the migration runner) owns the public tables
-- and can grant column-level SELECT from those tables without superuser.
-- Keeping the grants here means they are:
--   - applied automatically on every new instance (local dev, CI, prod);
--   - tracked in schema_migrations alongside every other schema change;
--   - visible in git history next to the code that depends on them.
-- This mirrors 0083_auth_resolvers_grants.sql, which split the Phase 62A
-- auth-resolver bootstrap the same way.
--
-- SECURITY DESIGN
-- ───────────────
-- qyrvia_auth_resolver is granted only the exact columns each resolver
-- function body reads, and nothing else:
--
--   worker_resolvers.pending_channel_tenants(integer) reads
--   public.channel_sync_queue_store.{tenant_id, status, next_retry_at,
--   next_run_at, retry_count, max_retries}
--
--   worker_resolvers.due_scheduler_tenants(integer) reads
--   public.scheduled_jobs.{tenant_id, status, run_at}
--
-- No table-wide SELECT is granted. No other column (payload, job_type,
-- identifiers beyond tenant_id, or any other) is granted. The resolver role
-- already holds BYPASSRLS from the bootstrap, which exempts it from the
-- source tables' FORCE ROW LEVEL SECURITY policies; it separately needs these
-- ordinary column-level SELECT privileges, because BYPASSRLS bypasses row
-- security policies only — it does not grant table privileges.
--
-- IDEMPOTENCE
-- ───────────
-- PostgreSQL GRANT is idempotent; re-running these grants is a no-op. The
-- precondition and postcondition checks below are re-evaluated on every run
-- and leave no residue: the snapshot table used to prove table ownership is
-- unchanged is a session-temporary table dropped automatically at COMMIT.

BEGIN;

-- ── 1. Snapshot pre-grant table ownership, for the postcondition check below.
--       A session-temporary table, not a permanent object; it never survives
--       past this transaction and never appears outside it.
CREATE TEMP TABLE phase66a_b2f_owner_snapshot (
  table_name   text PRIMARY KEY,
  owner_before text NOT NULL
) ON COMMIT DROP;

INSERT INTO phase66a_b2f_owner_snapshot (table_name, owner_before)
SELECT c.relname, pg_catalog.pg_get_userbyid(c.relowner)
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('channel_sync_queue_store', 'scheduled_jobs');

-- ── 2. Preconditions — fail closed with an actionable, sanitized error ─────
DO $$
DECLARE
  v_role_canlogin  boolean;
  v_role_super     boolean;
  v_role_bypassrls boolean;
BEGIN
  SELECT rolcanlogin, rolsuper, rolbypassrls
    INTO v_role_canlogin, v_role_super, v_role_bypassrls
    FROM pg_catalog.pg_roles
   WHERE rolname = 'qyrvia_auth_resolver';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'phase66a_b2f prerequisite not met: role qyrvia_auth_resolver does not '
      'exist. Run the worker-resolver bootstrap as a superuser first.';
  END IF;

  IF v_role_canlogin THEN
    RAISE EXCEPTION
      'phase66a_b2f refuses: qyrvia_auth_resolver must be NOLOGIN.';
  END IF;

  IF v_role_super THEN
    RAISE EXCEPTION
      'phase66a_b2f refuses: qyrvia_auth_resolver must not be SUPERUSER.';
  END IF;

  IF NOT v_role_bypassrls THEN
    RAISE EXCEPTION
      'phase66a_b2f refuses: qyrvia_auth_resolver must have BYPASSRLS.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'channel_sync_queue_store'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2f refuses: public.channel_sync_queue_store does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'scheduled_jobs'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2f refuses: public.scheduled_jobs does not exist.';
  END IF;

  IF (
    SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'channel_sync_queue_store'
       AND column_name IN (
         'tenant_id', 'status', 'next_retry_at', 'next_run_at',
         'retry_count', 'max_retries'
       )
  ) <> 6 THEN
    RAISE EXCEPTION
      'phase66a_b2f refuses: public.channel_sync_queue_store is missing a '
      'required column.';
  END IF;

  IF (
    SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'scheduled_jobs'
       AND column_name IN ('tenant_id', 'status', 'run_at')
  ) <> 3 THEN
    RAISE EXCEPTION
      'phase66a_b2f refuses: public.scheduled_jobs is missing a required '
      'column.';
  END IF;

  IF NOT (
    SELECT c.relrowsecurity FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'channel_sync_queue_store'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2f refuses: RLS is disabled on '
      'public.channel_sync_queue_store.';
  END IF;

  IF NOT (
    SELECT c.relforcerowsecurity FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'channel_sync_queue_store'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2f refuses: FORCE RLS is disabled on '
      'public.channel_sync_queue_store.';
  END IF;

  IF NOT (
    SELECT c.relrowsecurity FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'scheduled_jobs'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2f refuses: RLS is disabled on public.scheduled_jobs.';
  END IF;

  IF NOT (
    SELECT c.relforcerowsecurity FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'scheduled_jobs'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2f refuses: FORCE RLS is disabled on '
      'public.scheduled_jobs.';
  END IF;
END;
$$;

-- ── 3. Minimum column-level grants — exactly the columns each resolver body
--       reads, and nothing else. No table-wide SELECT.
GRANT SELECT (
  tenant_id,
  status,
  next_retry_at,
  next_run_at,
  retry_count,
  max_retries
) ON TABLE public.channel_sync_queue_store TO qyrvia_auth_resolver;

GRANT SELECT (
  tenant_id,
  status,
  run_at
) ON TABLE public.scheduled_jobs TO qyrvia_auth_resolver;

-- ── 4. Postconditions — any violation rolls the whole transaction back ─────
DO $$
DECLARE
  v_queue_cols   text[];
  v_jobs_cols    text[];
  v_owner_before text;
  v_owner_after  text;
BEGIN
  -- No table-wide (whole-table) SELECT ACL entry for qyrvia_auth_resolver.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
         pg_catalog.aclexplode(c.relacl) a
   WHERE n.nspname = 'public'
     AND c.relname IN ('channel_sync_queue_store', 'scheduled_jobs')
     AND pg_catalog.pg_get_userbyid(a.grantee) = 'qyrvia_auth_resolver'
     AND a.privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2f postcondition failed: table-wide SELECT ACL exists for '
      'qyrvia_auth_resolver.';
  END IF;

  -- No non-SELECT table-level privilege for qyrvia_auth_resolver.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
         pg_catalog.aclexplode(c.relacl) a
   WHERE n.nspname = 'public'
     AND c.relname IN ('channel_sync_queue_store', 'scheduled_jobs')
     AND pg_catalog.pg_get_userbyid(a.grantee) = 'qyrvia_auth_resolver'
     AND a.privilege_type <> 'SELECT'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2f postcondition failed: a non-SELECT table-level privilege '
      'exists for qyrvia_auth_resolver.';
  END IF;

  -- Exact queue column-level SELECT grant set — no missing, no extra.
  SELECT array_agg(column_name ORDER BY column_name) INTO v_queue_cols
    FROM information_schema.column_privileges
   WHERE grantee = 'qyrvia_auth_resolver' AND table_schema = 'public'
     AND table_name = 'channel_sync_queue_store' AND privilege_type = 'SELECT';

  IF v_queue_cols IS DISTINCT FROM ARRAY[
    'max_retries', 'next_retry_at', 'next_run_at', 'retry_count', 'status',
    'tenant_id'
  ] THEN
    RAISE EXCEPTION
      'phase66a_b2f postcondition failed: unexpected column-level SELECT '
      'grant set on public.channel_sync_queue_store for qyrvia_auth_resolver.';
  END IF;

  -- Exact jobs column-level SELECT grant set — no missing, no extra.
  SELECT array_agg(column_name ORDER BY column_name) INTO v_jobs_cols
    FROM information_schema.column_privileges
   WHERE grantee = 'qyrvia_auth_resolver' AND table_schema = 'public'
     AND table_name = 'scheduled_jobs' AND privilege_type = 'SELECT';

  IF v_jobs_cols IS DISTINCT FROM ARRAY['run_at', 'status', 'tenant_id'] THEN
    RAISE EXCEPTION
      'phase66a_b2f postcondition failed: unexpected column-level SELECT '
      'grant set on public.scheduled_jobs for qyrvia_auth_resolver.';
  END IF;

  -- No non-SELECT column-level privilege for qyrvia_auth_resolver.
  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges
     WHERE grantee = 'qyrvia_auth_resolver' AND table_schema = 'public'
       AND table_name IN ('channel_sync_queue_store', 'scheduled_jobs')
       AND privilege_type <> 'SELECT'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2f postcondition failed: a non-SELECT column-level privilege '
      'exists for qyrvia_auth_resolver.';
  END IF;

  -- PUBLIC received no privilege on either table, table-wide or per-column.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
         pg_catalog.aclexplode(c.relacl) a
   WHERE n.nspname = 'public'
     AND c.relname IN ('channel_sync_queue_store', 'scheduled_jobs')
     AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2f postcondition failed: PUBLIC holds a table-level '
      'privilege on a source table.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges
     WHERE grantee = 'PUBLIC' AND table_schema = 'public'
       AND table_name IN ('channel_sync_queue_store', 'scheduled_jobs')
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2f postcondition failed: PUBLIC holds a column-level '
      'privilege on a source table.';
  END IF;

  -- Table ownership unchanged, verified against the pre-grant snapshot —
  -- GRANT never changes ownership, and this check proves it stayed that way.
  FOR v_owner_before, v_owner_after IN
    SELECT s.owner_before, pg_catalog.pg_get_userbyid(c.relowner)
      FROM phase66a_b2f_owner_snapshot s
      JOIN pg_catalog.pg_class c ON c.relname = s.table_name
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
  LOOP
    IF v_owner_before IS DISTINCT FROM v_owner_after THEN
      RAISE EXCEPTION
        'phase66a_b2f postcondition failed: a source table owner changed '
        'during this migration.';
    END IF;
  END LOOP;

  -- RLS and FORCE RLS remain enabled on both tables.
  IF NOT (
    SELECT c.relrowsecurity FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'channel_sync_queue_store'
  ) OR NOT (
    SELECT c.relforcerowsecurity FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'channel_sync_queue_store'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2f postcondition failed: RLS or FORCE RLS is no longer '
      'enabled on public.channel_sync_queue_store.';
  END IF;

  IF NOT (
    SELECT c.relrowsecurity FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'scheduled_jobs'
  ) OR NOT (
    SELECT c.relforcerowsecurity FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'scheduled_jobs'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2f postcondition failed: RLS or FORCE RLS is no longer '
      'enabled on public.scheduled_jobs.';
  END IF;

  -- Resolver role attributes unchanged — this migration touches no role.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname = 'qyrvia_auth_resolver'
       AND (rolcanlogin OR rolsuper OR NOT rolbypassrls)
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2f postcondition failed: qyrvia_auth_resolver role '
      'attributes changed during this migration.';
  END IF;
END;
$$;

COMMIT;
