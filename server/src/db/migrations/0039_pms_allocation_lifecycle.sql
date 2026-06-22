-- QYRVIA Phase 7 / C7 - Allocation auto-consume + release sweep.
--
-- WHY: Phase 5.5 reserved the `allocations` table; without lifecycle commands
-- + a periodic sweep, sellable inventory leaks (reserved-but-never-used blocks
-- stay ACTIVE forever). Phase 6 added the generic scheduler; Phase 7 wires
-- a recurring sweep job that flips ACTIVE allocations to RELEASED when
-- `(date_from - release_days * INTERVAL '1 day') < today`.

CREATE INDEX IF NOT EXISTS idx_allocations_property_status
  ON allocations(property_id, status);
CREATE INDEX IF NOT EXISTS idx_allocations_release_window
  ON allocations(date_from) WHERE status = 'ACTIVE';

INSERT INTO permissions (code, description) VALUES
  ('allocation.release', 'Release an allocation (sweep or manual)')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('corporate_admin','property_admin','front_office_manager')
  AND p.code = 'allocation.release'
ON CONFLICT DO NOTHING;
