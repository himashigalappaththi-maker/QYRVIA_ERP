-- QYRVIA Phase 2 - real RLS policies replacing Phase 1 + 0002 open policies.
-- The application sets `app.tenant_id` via db.withTenant() on every transaction.
-- Super Admin operations bypass app-side, but the DB still enforces
-- tenant scoping when app.tenant_id is set.

-- Drop the temporary open policies
DROP POLICY IF EXISTS tenants_phase1_open      ON tenants;
DROP POLICY IF EXISTS properties_phase1_open   ON properties;
DROP POLICY IF EXISTS audit_events_phase1_open ON audit_events;
DROP POLICY IF EXISTS users_phase2_open        ON users;
DROP POLICY IF EXISTS user_roles_phase2_open   ON user_roles;
DROP POLICY IF EXISTS refresh_tokens_phase2_open ON refresh_tokens;

-- The shared predicate. When app.tenant_id isn't set (no SET LOCAL ran),
-- current_setting(..., true) returns NULL and the comparison is NULL (no rows
-- visible). The withTenant() helper ALWAYS sets it on the queries that need
-- it; queries from a privileged session (e.g. migrations) can SET it to a
-- specific value to operate per tenant, or use a SECURITY DEFINER function.

CREATE POLICY tenants_by_app          ON tenants
  USING (id::text         = current_setting('app.tenant_id', true));
CREATE POLICY properties_by_app       ON properties
  USING (tenant_id::text  = current_setting('app.tenant_id', true));
CREATE POLICY audit_events_by_app     ON audit_events
  USING (tenant_id::text  = current_setting('app.tenant_id', true));
CREATE POLICY users_by_app            ON users
  USING (tenant_id::text  = current_setting('app.tenant_id', true));
CREATE POLICY user_roles_by_app       ON user_roles
  USING (tenant_id::text  = current_setting('app.tenant_id', true));
CREATE POLICY refresh_tokens_by_app   ON refresh_tokens
  USING (tenant_id::text  = current_setting('app.tenant_id', true));

-- Append-only enforcement on audit_events at the role level.
-- Application code in core/eventBus.js only INSERTs; this is defense in depth.
REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;
