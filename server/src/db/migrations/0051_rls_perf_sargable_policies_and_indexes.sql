-- QYRVIA Phase 31 - RLS performance: SARGable tenant policies + tenant_id indexes.
--
-- Problem: every policy was `(tenant_id)::text = current_setting('app.tenant_id', true)`.
-- Casting the indexed uuid COLUMN to text is non-SARGable: the planner must
-- compute tenant_id::text for every row, so it cannot use a uuid index and falls
-- back to a Seq Scan that reads the whole table on every tenant query.
--
-- Fix: compare the column to a single casted CONSTANT instead. `app_current_tenant()`
-- is a STABLE, zero-arg function the planner evaluates once per query, so
-- `tenant_id = app_current_tenant()` is SARGable and uses a (tenant_id, ...) index.
-- It returns NULL when app.tenant_id is unset/empty OR not a valid uuid (a forged
-- or garbage context), so the predicate is NULL => zero rows (fail-closed) WITHOUT
-- raising - preserving the existing "no/garbage context => 0 rows" behaviour.

-- 1) Stable tenant-context accessor (safe cast: NULL on empty/invalid, never throws).
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE plpgsql STABLE AS $fn$
DECLARE v text := current_setting('app.tenant_id', true);
BEGIN
  IF v IS NULL OR v = '' THEN
    RETURN NULL;
  END IF;
  RETURN v::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$fn$;

-- 2) Recreate every RLS policy in SARGable form. Each tenant table gets one
--    canonical isolation policy with an EXPLICIT WITH CHECK (same predicate), so
--    SELECT/UPDATE/DELETE are scoped and INSERT/UPDATE are constrained to the
--    tenant. `tenants` is scoped by its own id; all other tenant tables by tenant_id.
DO $$
DECLARE r record; pol record; tcol text;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname,
      EXISTS (SELECT 1 FROM information_schema.columns col
              WHERE col.table_schema = 'public' AND col.table_name = c.relname
                AND col.column_name = 'tenant_id') AS has_tenant
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
  LOOP
    tcol := CASE WHEN r.has_tenant THEN 'tenant_id'
                 WHEN r.relname = 'tenants' THEN 'id'
                 ELSE NULL END;
    IF tcol IS NULL THEN
      CONTINUE;   -- RLS-enabled table with no tenant key (none expected); leave as-is
    END IF;

    FOR pol IN SELECT polname FROM pg_policy WHERE polrelid = r.oid LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.polname, r.relname);
    END LOOP;

    EXECUTE format(
      'CREATE POLICY %I ON public.%I USING (%I = app_current_tenant()) WITH CHECK (%I = app_current_tenant())',
      r.relname || '_tenant_isolation', r.relname, tcol, tcol);
  END LOOP;
END $$;

-- 3) Ensure a leading-tenant_id index on every tenant table so RLS predicates use
--    an index instead of a Seq Scan. Prefer (tenant_id, created_at) when present
--    (range/order friendly), else (tenant_id, id), else (tenant_id). Skips tables
--    that already have an index leading on tenant_id. Plain CREATE INDEX (not
--    CONCURRENTLY) so it is transaction-safe inside the migration runner.
DO $$
DECLARE r record; cols text; idxname text; has_created boolean; has_id boolean;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM information_schema.columns col
                  WHERE col.table_schema = 'public' AND col.table_name = c.relname
                    AND col.column_name = 'tenant_id')
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indrelid = r.oid AND a.attname = 'tenant_id'
    ) THEN
      CONTINUE;   -- already has a leading-tenant_id index
    END IF;

    has_created := EXISTS (SELECT 1 FROM information_schema.columns col
                           WHERE col.table_schema='public' AND col.table_name=r.relname AND col.column_name='created_at');
    has_id := EXISTS (SELECT 1 FROM information_schema.columns col
                      WHERE col.table_schema='public' AND col.table_name=r.relname AND col.column_name='id');
    cols := CASE WHEN has_created THEN 'tenant_id, created_at'
                 WHEN has_id THEN 'tenant_id, id'
                 ELSE 'tenant_id' END;
    idxname := 'ix_' || r.relname || '_tenant';
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (%s)', idxname, r.relname, cols);
  END LOOP;
END $$;
