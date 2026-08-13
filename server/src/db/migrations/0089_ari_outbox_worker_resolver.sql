-- QYRVIA Phase 66A (B2N-D) — minimum source-column grants for the ARI outbox
-- worker-resolver function.
--
-- PREREQUISITE
-- ────────────
-- A superuser bootstrap must have created worker_resolvers.due_ari_outbox_tenants
-- BEFORE this migration is applied. Which script depends on the environment:
--
--   fresh environment    scripts/db/phase66a_worker_resolvers_bootstrap.sql
--                        (now installs all three resolvers in one pass)
--   existing environment scripts/db/phase66a_ari_outbox_worker_resolver_bootstrap.sql
--                        (ADDITIVE — adds only the third resolver)
--
-- THIS MIGRATION DOES NOT CREATE THE FUNCTION, and cannot.
-- ───────────────────────────────────────────────────────
-- The function must be OWNED by qyrvia_auth_resolver, because SECURITY DEFINER
-- executes as the owner and only that role's BYPASSRLS can see across
-- ari_outbox_store's FORCE ROW LEVEL SECURITY. Ownership is conferred by
-- SET ROLE, which the migration runner cannot do: PostgreSQL refuses with 42501
-- "must be able to SET ROLE" because the runtime role is deliberately not a
-- member of that role.
--
-- A function created here instead would be owned by the application role, which
-- has no BYPASSRLS. It would then return ZERO rows forever — and "no rows" is
-- indistinguishable from "nothing to do", so the drain worker would report
-- healthy idle ticks while ARI events silently accumulated. That failure is
-- worse than having no worker at all, which is why this migration asserts the
-- function's provenance instead of creating it.
--
-- WHY THIS SPLIT
-- ──────────────
-- The bootstrap requires a superuser; these column grants do not. The
-- application role (which runs the migration runner) owns the public tables and
-- can grant column-level SELECT from those tables without superuser. Keeping
-- the grants here means they are:
--   - applied automatically on every new instance (local dev, CI, prod);
--   - tracked in schema_migrations alongside every other schema change;
--   - visible in git history next to the code that depends on them.
-- This mirrors 0085_worker_resolver_source_column_grants.sql and
-- 0083_auth_resolvers_grants.sql, which split their bootstraps the same way.
--
-- SECURITY DESIGN
-- ───────────────
-- qyrvia_auth_resolver is granted only the exact six columns the resolver
-- function body reads, and nothing else:
--
--   worker_resolvers.due_ari_outbox_tenants(integer) reads
--   public.ari_outbox_store.{tenant_id, status, retry_count, max_retries,
--   next_retry_at, lease_until}
--
-- No table-wide SELECT is granted. payload_json, dedupe_key, event_type,
-- resource_kind, property_id, room_type_id, rate_plan_id, restriction_rule_id,
-- source_version, lease_owner, attempts, id and every other timestamp column
-- are deliberately NOT granted — the resolver returns one fact per tenant
-- ("there is work here") and must not be able to read anything more. The
-- resolver role already holds BYPASSRLS from the bootstrap, which exempts it
-- from this table's FORCE ROW LEVEL SECURITY policy; it separately needs these
-- ordinary column-level SELECT privileges, because BYPASSRLS bypasses row
-- security policies only — it does not grant table privileges.
--
-- IDEMPOTENCE
-- ───────────
-- PostgreSQL GRANT is idempotent; re-running is a no-op. The postconditions
-- below are re-evaluated on every run and leave no residue.
--
-- TRANSACTION OWNERSHIP
-- ──────────────────────
-- This file contains no BEGIN, COMMIT or ROLLBACK. Transaction ownership
-- belongs to server/src/db/migrate.js, whose applyMigration() already wraps the
-- migration SQL and the schema_migrations tracking insert in one atomic
-- transaction. Forward-only, per repository convention. No DML, no backfill,
-- no function creation, no role creation, no role membership, no BYPASSRLS
-- change, no ownership change, no RLS or policy change.

-- ── The grant: exactly six columns, nothing else ────────────────────────────
GRANT SELECT (tenant_id, status, retry_count, max_retries, next_retry_at, lease_until)
  ON public.ari_outbox_store
  TO qyrvia_auth_resolver;

-- ── Postconditions: fail closed and roll the migration back on any violation ─
DO $$
DECLARE
  v_cols       text[];
  v_expected   text[] := ARRAY['lease_until','max_retries','next_retry_at',
                               'retry_count','status','tenant_id'];
  v_count      int;
  v_owner      text;
BEGIN
  -- 1. The resolver function must already exist (bootstrap ran first).
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers' AND p.proname = 'due_ari_outbox_tenants';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'phase66a_b2nd postcondition failed: worker_resolvers.due_ari_outbox_tenants '
      'does not exist. Run the appropriate superuser bootstrap BEFORE this '
      'migration (phase66a_worker_resolvers_bootstrap.sql on a fresh instance, '
      'phase66a_ari_outbox_worker_resolver_bootstrap.sql on an existing one).';
  END IF;

  -- 2. It must return exactly TABLE(tenant_id uuid) — one column, correct name.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'worker_resolvers' AND p.proname = 'due_ari_outbox_tenants'
       AND (p.proretset = false
            OR array_length(p.proargnames, 1) IS DISTINCT FROM 2
            OR p.proargnames[2] <> 'tenant_id')
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2nd postcondition failed: due_ari_outbox_tenants must return exactly TABLE(tenant_id uuid)';
  END IF;

  -- 3. Owner must be the BYPASSRLS definer role — otherwise it is vacuous.
  SELECT r.rolname INTO v_owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
   WHERE n.nspname = 'worker_resolvers' AND p.proname = 'due_ari_outbox_tenants';
  IF v_owner IS DISTINCT FROM 'qyrvia_auth_resolver' THEN
    RAISE EXCEPTION
      'phase66a_b2nd postcondition failed: due_ari_outbox_tenants is owned by %, '
      'expected qyrvia_auth_resolver (without that owner the function returns zero '
      'rows under FORCE RLS)', COALESCE(v_owner, '<null>');
  END IF;

  -- 4. SECURITY DEFINER.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'worker_resolvers' AND p.proname = 'due_ari_outbox_tenants'
       AND p.prosecdef = false
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nd postcondition failed: due_ari_outbox_tenants is not SECURITY DEFINER';
  END IF;

  -- 5. STABLE volatility (the committed worker-resolver contract).
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'worker_resolvers' AND p.proname = 'due_ari_outbox_tenants'
       AND p.provolatile <> 's'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nd postcondition failed: due_ari_outbox_tenants is not STABLE';
  END IF;

  -- 6. Fixed search_path — a definer function without one can be hijacked.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'worker_resolvers' AND p.proname = 'due_ari_outbox_tenants'
       AND (p.proconfig IS NULL
            OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg
                            WHERE cfg = 'search_path=pg_catalog, public, pg_temp'))
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2nd postcondition failed: due_ari_outbox_tenants has no fixed search_path=pg_catalog, public, pg_temp';
  END IF;

  -- 7. PUBLIC must not be able to execute it.
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges rp
     WHERE rp.routine_schema = 'worker_resolvers'
       AND rp.privilege_type = 'EXECUTE'
       AND rp.grantee        = 'PUBLIC'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nd postcondition failed: PUBLIC can execute a worker resolver';
  END IF;

  -- 8. The application role running this migration IS the role that will call
  --    the resolver at runtime, so check its EXECUTE privilege directly rather
  --    than trusting a configured name.
  IF NOT has_function_privilege(current_user,
         'worker_resolvers.due_ari_outbox_tenants(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION
      'phase66a_b2nd postcondition failed: the application role cannot EXECUTE '
      'due_ari_outbox_tenants. Re-run the bootstrap with the correct APP_ROLE.';
  END IF;

  -- 9. EXACTLY the six intended columns are granted, and no more. Sorted
  --    comparison, so grant order can never make this pass or fail spuriously.
  SELECT array_agg(cp.column_name::text ORDER BY cp.column_name) INTO v_cols
    FROM information_schema.column_privileges cp
   WHERE cp.table_schema  = 'public'
     AND cp.table_name    = 'ari_outbox_store'
     AND cp.grantee       = 'qyrvia_auth_resolver'
     AND cp.privilege_type = 'SELECT';
  IF v_cols IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION
      'phase66a_b2nd postcondition failed: qyrvia_auth_resolver holds SELECT on % '
      'ari_outbox_store column(s), expected exactly the six predicate columns',
      COALESCE(array_length(v_cols, 1), 0);
  END IF;

  -- 10. No table-wide SELECT may have been granted alongside the column grants.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants g
     WHERE g.table_schema = 'public'
       AND g.table_name   = 'ari_outbox_store'
       AND g.grantee      = 'qyrvia_auth_resolver'
       AND g.privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2nd postcondition failed: qyrvia_auth_resolver holds table-wide '
      'SELECT on ari_outbox_store — only column-level grants are permitted';
  END IF;

  -- 11. No write privilege of any kind on the outbox.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants g
     WHERE g.table_schema = 'public'
       AND g.table_name   = 'ari_outbox_store'
       AND g.grantee      = 'qyrvia_auth_resolver'
       AND g.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2nd postcondition failed: qyrvia_auth_resolver holds a write '
      'privilege on ari_outbox_store — the resolver is read-only by design';
  END IF;

  -- 12. The approved worker_resolvers set is exactly three functions.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'worker_resolvers';
  IF v_count <> 3 THEN
    RAISE EXCEPTION
      'phase66a_b2nd postcondition failed: worker_resolvers holds % function(s), expected exactly 3',
      v_count;
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'worker_resolvers'
         AND p.proname IN ('pending_channel_tenants', 'due_scheduler_tenants',
                           'due_ari_outbox_tenants')) <> 3 THEN
    RAISE EXCEPTION
      'phase66a_b2nd postcondition failed: worker_resolvers is missing one of the three approved functions by name';
  END IF;

  -- 13. ari_outbox_store keeps RLS and FORCE RLS. Column grants must never be
  --     an accidental route to relaxing row security.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'ari_outbox_store')
     OR NOT (SELECT c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'ari_outbox_store') THEN
    RAISE EXCEPTION 'phase66a_b2nd postcondition failed: ari_outbox_store lost RLS or FORCE RLS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'ari_outbox_store'
       AND policyname = 'ari_outbox_store_by_app'
       AND qual IS NOT NULL AND with_check IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nd postcondition failed: the tenant policy lost its USING or WITH CHECK';
  END IF;

  -- 14. The 0087 and 0088 structural contracts are intact.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'ari_outbox_store' AND con.conname = 'uq_aob_logical_event'
       AND con.contype = 'u'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nd postcondition failed: uq_aob_logical_event missing (0087)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'ari_outbox_store'
       AND con.conname = 'ari_outbox_store_property_same_tenant_fk' AND con.contype = 'f'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nd postcondition failed: the same-tenant composite property FK is missing (0087)';
  END IF;

  IF (SELECT count(*) FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname = 'ari_outbox_store'
         AND con.conname IN ('ari_outbox_store_restriction_rule_id_nonempty',
                             'ari_outbox_store_room_type_nonempty',
                             'ari_outbox_store_room_type_required',
                             'ari_outbox_store_rate_plan_compat',
                             'ari_outbox_store_restriction_event_compat',
                             'ari_outbox_store_key_version_compat')) <> 6 THEN
    RAISE EXCEPTION 'phase66a_b2nd postcondition failed: not all six 0088 restriction-scope CHECK constraints are present';
  END IF;

  IF (SELECT count(*) FROM pg_indexes
       WHERE tablename = 'ari_outbox_store'
         AND indexname IN ('idx_aob_claim','idx_aob_retry_due','idx_aob_lease_expiry')) <> 3 THEN
    RAISE EXCEPTION 'phase66a_b2nd postcondition failed: a claim/retry/lease index is missing (0087)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ari_outbox_store'
       AND column_name = 'reservation_id'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nd postcondition failed: ari_outbox_store must never carry reservation_id';
  END IF;

  -- 15. The resolver role's own attributes are unchanged by this migration.
  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'qyrvia_auth_resolver' AND (rolcanlogin OR rolsuper OR NOT rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nd postcondition failed: qyrvia_auth_resolver role attributes changed';
  END IF;
END;
$$;
