-- Phase 62A: Column-level SELECT grants on public tables to qyrvia_auth_resolver.
--
-- PREREQUISITE
-- ────────────
-- scripts/db/phase62a_auth_resolvers_bootstrap.sql must be run by a superuser
-- BEFORE this migration is applied. That script creates:
--   - role qyrvia_auth_resolver (NOLOGIN BYPASSRLS)
--   - schema auth_resolvers (owned by qyrvia_auth_schema_owner)
--   - 4 SECURITY DEFINER resolver functions owned by qyrvia_auth_resolver
--   - EXECUTE grants on those functions to the application login role (APP_ROLE)
--   - USAGE grant on auth_resolvers schema to APP_ROLE
--
-- WHY THIS SPLIT
-- ──────────────
-- The bootstrap requires a superuser; these column grants do not. The application
-- role (which runs the migration runner) owns the public tables and can grant
-- column-level SELECT from those tables without superuser. Keeping the grants
-- here means they are:
--   - applied automatically on every new instance (local dev, CI, prod);
--   - tracked in schema_migrations alongside every other schema change;
--   - visible in git history next to the code that depends on them.
--
-- SECURITY DESIGN
-- ───────────────
-- qyrvia_auth_resolver is granted only the exact columns each function reads.
-- No password_hash column is granted (the functions never return it).
-- Resolver functions run as SECURITY DEFINER under qyrvia_auth_resolver's
-- BYPASSRLS attribute to look up user/tenant/token identifiers before the
-- application has established an RLS tenant context (pre-auth phase).
-- After resolution, all operational queries run via the normal RLS+GUC path.
--
-- IDEMPOTENCE
-- ───────────
-- PostgreSQL GRANT is idempotent; re-running these grants is a no-op.

-- Guard: fail closed with an actionable error if the bootstrap was not run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qyrvia_auth_resolver') THEN
    RAISE EXCEPTION
      'Phase 62A prerequisite not met: role qyrvia_auth_resolver does not exist. '
      'Run scripts/db/phase62a_auth_resolvers_bootstrap.sql as a superuser, '
      'then re-apply migrations.';
  END IF;
END;
$$;

-- public.users: resolve_by_email needs id, tenant_id, email, soft_deleted_at
--               resolve_by_tenant_username additionally needs username
--               resolve_by_property_id_username additionally needs tenant_id (via join)
GRANT SELECT (id, tenant_id, email, username, soft_deleted_at)
  ON public.users TO qyrvia_auth_resolver;

-- public.tenants: resolve_by_tenant_username needs id, code
GRANT SELECT (id, code)
  ON public.tenants TO qyrvia_auth_resolver;

-- public.properties: resolve_by_property_id_username needs id, tenant_id, active
GRANT SELECT (id, tenant_id, active)
  ON public.properties TO qyrvia_auth_resolver;

-- public.refresh_tokens: resolve_refresh_token_by_hash needs id, tenant_id, user_id, token_hash
GRANT SELECT (id, tenant_id, user_id, token_hash)
  ON public.refresh_tokens TO qyrvia_auth_resolver;
