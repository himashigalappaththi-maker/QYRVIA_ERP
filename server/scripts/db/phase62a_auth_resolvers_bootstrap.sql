-- ============================================================================
-- phase62a_auth_resolvers_bootstrap.sql
-- Phase 62A — Auth Resolver Infrastructure Bootstrap
-- ============================================================================
-- PRIVILEGE REQUIRED: Superuser (or a role with CREATEROLE + BYPASSRLS).
-- DO NOT RUN VIA THE MIGRATION RUNNER. Run this once as a DBA/operator before
-- running migrations on any new database instance (local dev, staging, prod).
--
-- WHAT THIS CREATES
-- ─────────────────
-- 1. qyrvia_auth_schema_owner — NOLOGIN NOBYPASSRLS — owns auth_resolvers schema
-- 2. qyrvia_auth_resolver     — NOLOGIN BYPASSRLS   — owns 4 SECURITY DEFINER functions
-- 3. auth_resolvers schema (owned by #1, NOT by the BYPASSRLS role)
-- 4. Four SECURITY DEFINER resolver functions (owned by #2)
-- 5. EXECUTE grants on all four functions → APP_ROLE (the application login role)
-- 6. USAGE grant on auth_resolvers schema → APP_ROLE
--
-- WHAT BELONGS IN MIGRATION 0083 (NOT HERE)
-- ──────────────────────────────────────────
-- Column-level SELECT grants on public.users / tenants / properties /
-- refresh_tokens → qyrvia_auth_resolver. Those run via the migration runner as
-- the application role (which owns the public tables) — no superuser needed.
--
-- SECURITY INVARIANTS PRESERVED
-- ──────────────────────────────
-- * qyrvia_auth_resolver owns only the 4 functions; no tables, no schema.
-- * qyrvia_auth_schema_owner owns the schema; it is NOBYPASSRLS and NOLOGIN.
-- * BYPASSRLS is confined to qyrvia_auth_resolver, which cannot log in.
-- * Functions are STABLE, use fixed safe search_path, and return only the
--   minimum columns required (no password_hash, no complete rows).
-- * PUBLIC has no EXECUTE access to any resolver function.
-- * APP_ROLE is supplied explicitly by the operator — never interpolated from
--   an unvalidated source; psql quoted-identifier syntax (:"APP_ROLE") prevents
--   identifier injection.
-- * Assertions inside a DO block at the end fail the transaction if any
--   invariant is violated — the transaction is rolled back atomically.
--
-- USAGE
-- ─────
--   psql "$DATABASE_URL" \
--       --set APP_ROLE=<application_role> \
--       --single-transaction \
--       -f scripts/db/phase62a_auth_resolvers_bootstrap.sql
--
-- Local dev example (application role = qyrvia_test):
--   psql "postgresql://postgres:pw@127.0.0.1:5432/qyrvia_test" \
--       --set APP_ROLE=qyrvia_test \
--       --single-transaction \
--       -f scripts/db/phase62a_auth_resolvers_bootstrap.sql
--
-- IDEMPOTENCE
-- ───────────
-- CREATE ROLE and CREATE SCHEMA are guarded by IF NOT EXISTS. Functions use
-- CREATE OR REPLACE. GRANT is idempotent in PostgreSQL. Re-running is safe as
-- long as existing roles/schema have the expected attributes (assertions check
-- this and abort if anything is unexpected).
--
-- ROLLBACK / RECOVERY
-- ───────────────────
-- The entire script runs inside a single transaction (BEGIN … COMMIT). Any
-- assertion failure (step 10) rolls back all changes atomically. To fully
-- remove the auth resolver infrastructure:
--   DROP SCHEMA auth_resolvers CASCADE;
--   DROP ROLE qyrvia_auth_resolver;
--   DROP ROLE qyrvia_auth_schema_owner;
-- Then re-run this script.
-- ============================================================================

\set ON_ERROR_STOP on

\if :{?APP_ROLE}
\else
\warn 'ERROR: APP_ROLE variable is not set.'
\warn 'Run with: psql <url> --set APP_ROLE=<application_login_role> -f <this-script>'
\quit
\endif

BEGIN;

-- ── 1. Create schema-owner role (NOLOGIN NOBYPASSRLS) ──────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qyrvia_auth_schema_owner') THEN
    CREATE ROLE qyrvia_auth_schema_owner
      NOLOGIN NOINHERIT NOBYPASSRLS
      NOCREATEDB NOCREATEROLE NOSUPERUSER;
  ELSE
    IF EXISTS (
      SELECT 1 FROM pg_roles
       WHERE rolname = 'qyrvia_auth_schema_owner'
         AND (rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolcanlogin)
    ) THEN
      RAISE EXCEPTION
        'qyrvia_auth_schema_owner already exists with unexpected privileges '
        '(expected NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB) — bootstrap aborted';
    END IF;
  END IF;
END;
$$;

-- ── 2. Create resolver role (NOLOGIN BYPASSRLS) ────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qyrvia_auth_resolver') THEN
    CREATE ROLE qyrvia_auth_resolver
      NOLOGIN NOINHERIT BYPASSRLS
      NOCREATEDB NOCREATEROLE NOSUPERUSER;
  ELSE
    IF EXISTS (
      SELECT 1 FROM pg_roles
       WHERE rolname = 'qyrvia_auth_resolver'
         AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolcanlogin)
    ) THEN
      RAISE EXCEPTION
        'qyrvia_auth_resolver already exists with unexpected privileges '
        '(expected NOLOGIN BYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB) — bootstrap aborted';
    END IF;
  END IF;
END;
$$;

-- ── 3. Create auth_resolvers schema (owned by schema-owner, NOT BYPASSRLS role) ──
CREATE SCHEMA IF NOT EXISTS auth_resolvers;
ALTER SCHEMA auth_resolvers OWNER TO qyrvia_auth_schema_owner;

-- ── 4. Grant temporary CREATE + USAGE on schema to function-owner ───────────
--    CREATE is revoked immediately after functions are installed (step 7).
GRANT USAGE  ON SCHEMA auth_resolvers TO qyrvia_auth_resolver;
GRANT CREATE ON SCHEMA auth_resolvers TO qyrvia_auth_resolver;

-- ── 5. Switch to function-owner to create SECURITY DEFINER functions ─────────
--    Functions created under this role are owned by qyrvia_auth_resolver,
--    which has BYPASSRLS. SECURITY DEFINER then executes them as that owner,
--    allowing the functions to SELECT across FORCE RLS boundaries.
SET LOCAL ROLE qyrvia_auth_resolver;

-- 5a. email → user_id, tenant_id
CREATE OR REPLACE FUNCTION auth_resolvers.resolve_by_email(p_email TEXT)
RETURNS TABLE(user_id UUID, tenant_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, auth_resolvers, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT u.id, u.tenant_id
      FROM public.users u
     WHERE lower(u.email) = lower(p_email)
       AND u.soft_deleted_at IS NULL
     LIMIT 1;
END;
$$;

-- 5b. tenant_code + username → user_id, tenant_id
CREATE OR REPLACE FUNCTION auth_resolvers.resolve_by_tenant_username(
  p_tenant_code TEXT,
  p_username    TEXT
)
RETURNS TABLE(user_id UUID, tenant_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, auth_resolvers, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT u.id, t.id
      FROM public.users u
      JOIN public.tenants t ON t.id = u.tenant_id
     WHERE t.code     = p_tenant_code
       AND u.username = p_username
       AND u.soft_deleted_at IS NULL
     LIMIT 1;
END;
$$;

-- 5c. property_id UUID + username → user_id, tenant_id, property_id
CREATE OR REPLACE FUNCTION auth_resolvers.resolve_by_property_id_username(
  p_property_id UUID,
  p_username    TEXT
)
RETURNS TABLE(user_id UUID, tenant_id UUID, property_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, auth_resolvers, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT u.id, t.id, p.id
      FROM public.properties p
      JOIN public.tenants t ON t.id = p.tenant_id
      JOIN public.users   u ON u.tenant_id = t.id
                           AND u.username  = p_username
                           AND u.soft_deleted_at IS NULL
     WHERE p.id     = p_property_id
       AND p.active = true
     LIMIT 1;
END;
$$;

-- 5d. refresh_token_hash → token_id, tenant_id, user_id
CREATE OR REPLACE FUNCTION auth_resolvers.resolve_refresh_token_by_hash(p_hash TEXT)
RETURNS TABLE(token_id UUID, tenant_id UUID, user_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, auth_resolvers, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT rt.id, rt.tenant_id, rt.user_id
      FROM public.refresh_tokens rt
     WHERE rt.token_hash = p_hash
     LIMIT 1;
END;
$$;

-- ── 6. Return to superuser ──────────────────────────────────────────────────
RESET ROLE;

-- ── 7. Revoke CREATE from function-owner (schema remains with schema-owner) ──
REVOKE CREATE ON SCHEMA auth_resolvers FROM qyrvia_auth_resolver;

-- ── 8. Restrict EXECUTE: revoke from PUBLIC, grant only to APP_ROLE ──────────
--    :"APP_ROLE" uses psql quoted-identifier substitution — safe against
--    identifier injection regardless of what the operator supplied.
REVOKE ALL ON FUNCTION auth_resolvers.resolve_by_email(TEXT)                       FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolvers.resolve_by_tenant_username(TEXT, TEXT)       FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolvers.resolve_by_property_id_username(UUID, TEXT)  FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolvers.resolve_refresh_token_by_hash(TEXT)          FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth_resolvers.resolve_by_email(TEXT)                       TO :"APP_ROLE";
GRANT EXECUTE ON FUNCTION auth_resolvers.resolve_by_tenant_username(TEXT, TEXT)       TO :"APP_ROLE";
GRANT EXECUTE ON FUNCTION auth_resolvers.resolve_by_property_id_username(UUID, TEXT)  TO :"APP_ROLE";
GRANT EXECUTE ON FUNCTION auth_resolvers.resolve_refresh_token_by_hash(TEXT)          TO :"APP_ROLE";

-- ── 9. Grant USAGE on auth_resolvers schema to APP_ROLE ──────────────────────
--    EXECUTE on a function in a schema requires USAGE on that schema.
--    The schema is owned by qyrvia_auth_schema_owner (not the migration runner),
--    so this grant must stay in the privileged bootstrap.
GRANT USAGE ON SCHEMA auth_resolvers TO :"APP_ROLE";

-- ── 10. Assertions — fail the transaction if any invariant is violated ────────
DO $$
DECLARE
  v_fn_count       int;
  v_wrong_owner    int;
  v_not_secdef     int;
  v_not_stable     int;
  v_schema_owner   text;
  v_public_exec    int;
BEGIN
  -- 10a. Exactly four resolver functions exist
  SELECT count(*) INTO v_fn_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'auth_resolvers';
  IF v_fn_count <> 4 THEN
    RAISE EXCEPTION 'Expected 4 resolver functions, found %', v_fn_count;
  END IF;

  -- 10b. All four functions owned by qyrvia_auth_resolver
  SELECT count(*) INTO v_wrong_owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r     ON r.oid = p.proowner
   WHERE n.nspname = 'auth_resolvers'
     AND r.rolname <> 'qyrvia_auth_resolver';
  IF v_wrong_owner > 0 THEN
    RAISE EXCEPTION '% function(s) in auth_resolvers owned by wrong role (expected qyrvia_auth_resolver)',
                    v_wrong_owner;
  END IF;

  -- 10c. All four functions are SECURITY DEFINER
  SELECT count(*) INTO v_not_secdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'auth_resolvers'
     AND p.prosecdef = false;
  IF v_not_secdef > 0 THEN
    RAISE EXCEPTION '% function(s) in auth_resolvers are NOT SECURITY DEFINER', v_not_secdef;
  END IF;

  -- 10d. All four functions are STABLE (not VOLATILE)
  SELECT count(*) INTO v_not_stable
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'auth_resolvers'
     AND p.provolatile <> 's';
  IF v_not_stable > 0 THEN
    RAISE EXCEPTION '% function(s) in auth_resolvers are NOT STABLE', v_not_stable;
  END IF;

  -- 10e. Schema owned by qyrvia_auth_schema_owner (not by the BYPASSRLS resolver)
  SELECT r.rolname INTO v_schema_owner
    FROM pg_namespace n
    JOIN pg_roles r ON r.oid = n.nspowner
   WHERE n.nspname = 'auth_resolvers';
  IF v_schema_owner IS DISTINCT FROM 'qyrvia_auth_schema_owner' THEN
    RAISE EXCEPTION 'auth_resolvers schema owner is %, expected qyrvia_auth_schema_owner',
                    COALESCE(v_schema_owner, '<null>');
  END IF;

  -- 10f. PUBLIC has no EXECUTE on any resolver function
  SELECT count(*) INTO v_public_exec
    FROM information_schema.routine_privileges rp
   WHERE rp.routine_schema = 'auth_resolvers'
     AND rp.privilege_type = 'EXECUTE'
     AND rp.grantee        = 'PUBLIC';
  IF v_public_exec > 0 THEN
    RAISE EXCEPTION 'PUBLIC has EXECUTE on % resolver function(s) — expected zero', v_public_exec;
  END IF;

  RAISE NOTICE
    'phase62a_auth_resolvers_bootstrap assertions PASSED: % functions, schema owner = %, no PUBLIC EXECUTE',
    v_fn_count, v_schema_owner;
END;
$$;

COMMIT;
