-- QYRVIA Phase 67A-003 — critical SaaS safety remediation, Workstream A/G (RLS).
--
-- VERIFICATION METHOD (per the instruction 003 brief's explicit demand to
-- "manually resolve dynamic SQL and loops; do not rely only on grep"):
-- ─────────────────────────────────────────────────────────────────────────
-- Every one of migrations 0001-0089 was read, and a table/RLS inventory was
-- built programmatically (table-creation bodies, ALTER TABLE ... ENABLE/FORCE
-- ROW LEVEL SECURITY, and CREATE POLICY statements) rather than assumed
-- from a prior audit. Three migrations use DYNAMIC SQL (a PL/pgSQL loop
-- with EXECUTE format(...)) that a naive per-file grep cannot resolve:
--
--   0049_ari_foundation.sql  — loops over 7 ari_* tables, applying
--     ENABLE + FORCE RLS + a policy to each via EXECUTE format(...).
--   0050_ota_transport.sql   — same pattern for 3 ota_* tables.
--   0051_rls_perf_sargable_policies_and_indexes.sql — a SELF-DISCOVERING
--     sweep: for EVERY table in `public` that already has RLS ENABLED at
--     the point 0051 runs (regardless of which earlier migration created
--     it or how many/which policies it had), it drops ALL of that table's
--     existing policies and recreates exactly one canonical
--     `<table>_tenant_isolation` policy using the SARGABLE
--     `app_current_tenant()` form with an EXPLICIT WITH CHECK clause. This
--     single migration is why the ORIGINAL non-sargable, no-explicit-
--     WITH-CHECK policies created by migrations 0001/0004 (tenants,
--     properties, audit_events, users, user_roles, refresh_tokens) and by
--     0049/0050 (the 10 ari_*/ota_* tables above) do NOT still exist in
--     the current schema — 0051 replaced every one of them.
--
-- Resolving all three of the above (reading their full loop bodies, not
-- just grepping for literal "ALTER TABLE <name>" text next to "ROW LEVEL
-- SECURITY") produces this DEFINITIVE, migration-derived inventory:
--
--   - 121 tables are created across migrations 0001-0089.
--   - 115 require tenant isolation (every table except the 6 genuine
--     global/system catalogs with no tenant_id column and no per-tenant
--     data: schema_migrations, roles, permissions, role_permissions,
--     connectors, settings_schema). `tenants` itself is the 115th —
--     scoped by its own `id`, not a `tenant_id` foreign key.
--   - ALL 115 have ENABLE + FORCE ROW LEVEL SECURITY, applied either in
--     their own creating migration or via 0051's sweep. None is missing
--     either flag; none has been found with DISABLE ROW LEVEL SECURITY.
--   - ALL 115 have at least one tenant-isolation policy. 113 of the 115
--     use the canonical sargable `tenant_id = app_current_tenant()` (or,
--     for `tenants`, `id = app_current_tenant()`) form WITH an explicit
--     WITH CHECK, either from their own migration (if created after 0051)
--     or via 0051's retroactive sweep (if created before it).
--   - EXACTLY TWO tables were found using the OLDER, pre-0051,
--     non-sargable `current_setting('app.tenant_id', true)` form, because
--     both were created by a migration numbered AFTER 0051 (so 0051's
--     one-time sweep never touched them):
--       channel_registry (migration 0055) — NO explicit WITH CHECK.
--         Functionally safe today (Postgres defaults an omitted WITH
--         CHECK to the same expression as USING for a FOR-ALL policy,
--         so this is not an active bypass), but inconsistent with the
--         established convention and non-SARGable (full seq-scan cost on
--         every query against this table). CORRECTED by this migration
--         (see Part 2 below).
--       ari_outbox_store (migration 0087, Phase 66A — PROTECTED, not
--         touched by this or any Phase 67A migration) — HAS an explicit
--         WITH CHECK, so it is fully safe as-is; left untouched both
--         because it is protected and because there is no security
--         justification to change it.
--
-- This DIRECTLY CONTRADICTS NEITHER the original prior-audit claim
-- ("missing FORCE RLS") NOR blindly accepts the earlier Phase 67A report's
-- claim without re-derivation — both are independently re-verified here
-- via full migration-chain reading, including every dynamic-SQL loop.
--
-- WHAT THIS MIGRATION DOES (three parts):
--   1. An IDEMPOTENT reassertion of ENABLE + FORCE ROW LEVEL SECURITY for
--      any table with a tenant_id column that is somehow missing either
--      flag TODAY. Per the verification above, this branch is a NO-OP
--      against the current, actually-migrated schema — it exists purely
--      as a safety net against configuration drift between when this
--      migration is written and when it is actually applied to a given
--      environment. IT DOES NOT AND CANNOT PROTECT ANY TABLE ADDED BY A
--      MIGRATION WRITTEN AFTER THIS ONE — migration 0090 runs exactly
--      once, at the point it is first applied; it does not re-run on
--      every future migration. Every future migration that adds a
--      tenant-scoped table MUST include its own ENABLE + FORCE ROW LEVEL
--      SECURITY + tenant-isolation policy statements (a reusable
--      migration-time postcondition, matching Part 3 below, is the
--      correct place to keep that a hard requirement going forward — see
--      the postcondition in Part 3, which DOES run every time THIS
--      migration file is applied, but again, only once, ever).
--   2. Corrects channel_registry's policy to the established sargable,
--      explicit-WITH-CHECK convention.
--   3. A migration-time postcondition that RAISES AN EXCEPTION (aborting
--      the whole migration transaction) if, after the above, ANY table
--      with a tenant_id column either (a) lacks ENABLE or FORCE ROW LEVEL
--      SECURITY, OR (b) has ZERO policies defined. This migration does
--      NOT auto-create a generic policy for a table with zero policies —
--      an earlier draft of this migration did exactly that (a `FOR ALL`
--      policy assuming a plain `tenant_id = app_current_tenant()`
--      predicate fits every table), which is a real risk: inventing
--      policy semantics for a table this migration does not actually
--      understand the data model of. This version FAILS CLOSED instead —
--      if a future application of this migration ever finds a
--      policy-less tenant table, the migration aborts with a clear error
--      naming the table, and a human must write that table's correct
--      policy explicitly, rather than silently getting an assumed one.
--
-- OUT OF SCOPE FOR THIS MIGRATION: PROPERTY-level RLS.
--   PROPERTY_LEVEL_RLS_IMPLEMENTED=false
-- Every existing policy — before and after this migration — isolates by
-- tenant_id (or, for `tenants`, by id) only; there is no app.property_id
-- session variable anywhere in this codebase, and no RLS policy anywhere
-- checks property_id. Property-level access control is enforced entirely
-- at the application layer today (identityContext.js / repos.js
-- canAccessProperty()). Adding a database-level property_id predicate
-- would require introducing a new session context variable and updating
-- db/client.js plus every property-scoped command/route across the
-- codebase to set it correctly — none of which are in this phase's
-- permitted file scope, and doing it partially would silently return zero
-- rows for every property-scoped query. That is a separate, larger
-- remediation phase, not a Phase 67A surgical fix.
--
-- SAFETY: idempotent (IF EXISTS / conditional guards throughout); does not
-- drop any customer data; does not disable RLS anywhere; does not grant
-- BYPASSRLS or superuser to any role; does not invent a generic policy for
-- an unknown table (fails closed with RAISE EXCEPTION instead); does not
-- modify migration 0089 or any earlier migration file; does not touch
-- ari_outbox_store (Phase 66A / protected).

-- ============================================================================
-- 1) Idempotent ENABLE + FORCE ROW LEVEL SECURITY reassertion. Per the
--    verification above, a no-op against the current schema — a defensive
--    safety net only. Does NOT create policies for a table that lacks one
--    (see the header note on why the auto-policy-creation branch present
--    in an earlier draft was removed) — Part 3's postcondition catches
--    that case instead and aborts the migration.
-- ============================================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name = c.relname
          AND col.column_name = 'tenant_id'
      )
  LOOP
    IF NOT r.relrowsecurity THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    END IF;
    IF NOT r.relforcerowsecurity THEN
      EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', r.relname);
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- 2) Correct channel_registry's policy to the established SARGable,
--    explicit-WITH-CHECK convention (migration 0055 predates this pattern
--    for this one table only — it was created after migration 0051's
--    one-time sweep, so it never received the correction that sweep gave
--    every table that already existed at that point).
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'channel_registry'
  ) THEN
    DROP POLICY IF EXISTS channel_registry_tenant_isolation ON channel_registry;
    CREATE POLICY channel_registry_tenant_isolation ON channel_registry
      USING      (tenant_id = app_current_tenant())
      WITH CHECK (tenant_id = app_current_tenant());
  END IF;
END $$;

-- ============================================================================
-- 3) Postcondition: fail the migration if any tenant-scoped table is left
--    without FORCE ROW LEVEL SECURITY, OR has zero policies defined. This
--    is a hard guarantee, checked every time this migration file is
--    applied (once, ever, per environment) — it does not run again for
--    migrations written after this one; each of those must supply its own
--    RLS statements and is responsible for its own correctness.
-- ============================================================================
DO $$
DECLARE
  missing_forced text;
  missing_policy text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO missing_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name = c.relname
          AND col.column_name = 'tenant_id'
      )
      AND (c.relrowsecurity IS NOT TRUE OR c.relforcerowsecurity IS NOT TRUE);

  IF missing_forced IS NOT NULL THEN
    RAISE EXCEPTION 'phase67a postcondition failed: table(s) with tenant_id lacking ENABLE+FORCE ROW LEVEL SECURITY: %', missing_forced;
  END IF;

  SELECT string_agg(c.relname, ', ')
    INTO missing_policy
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name = c.relname
          AND col.column_name = 'tenant_id'
      )
      AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = c.oid);

  IF missing_policy IS NOT NULL THEN
    RAISE EXCEPTION 'phase67a postcondition failed: table(s) with tenant_id have ZERO RLS policies (this migration does not invent one — write an explicit, data-model-correct policy for): %', missing_policy;
  END IF;
END $$;
