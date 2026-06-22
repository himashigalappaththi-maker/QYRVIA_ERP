-- QYRVIA Phase 6 / C1+C2+C3 - Multi-property auth helper indexes.
--
-- WHY: Phase 6 adds:
--   * GET /api/auth/properties  -- list properties the current user can access
--   * POST /api/auth/switch-property  -- re-issue tokens scoped to a target property
--   * POST /api/auth/login  -- accepts property_code (in addition to tenant_code)
--
-- All three reads pivot on (user_id, property_id) in user_roles and
-- (code, tenant_id) in properties. These partial indexes make the lookups
-- O(log n) rather than seq scans.

CREATE INDEX IF NOT EXISTS idx_user_roles_user_property
  ON user_roles(user_id, property_id)
  WHERE property_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_properties_code_tenant
  ON properties(code, tenant_id);
