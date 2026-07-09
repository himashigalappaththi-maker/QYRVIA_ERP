-- QYRVIA Phase 52 - ARI Booking Engine Commercial Core: RBAC permission codes.
--
-- WHY: The booking engine exposes two distinct access planes:
--
--   pms.ari.read  — read-only access to the ARI inventory grid, rate plans,
--                   room types, restrictions, and availability calendars.
--                   Granted to operational roles that need to quote stays
--                   or view inventory without being able to mutate it.
--
--   pms.ari.write — full mutation access: adjustSold, block/unblock,
--                   stop-sell toggles, rate overrides. Granted to
--                   administrative and front-office roles.
--
-- Role assignments use the roles seeded in 0003_seed_roles.sql.  There is no
-- revenue_manager role in the schema; the closest operational owners are
-- property_admin (full property authority) and front_office_manager (daily
-- revenue operations).  corporate_admin receives both codes via its blanket
-- grant pattern (pms.% prefix, consistent with 0021_pms_permissions.sql).
--
-- All inserts are ON CONFLICT DO NOTHING / idempotent so the migration can be
-- re-run safely.  Additive only — no DROP, no ALTER.

-- 1) Register the permission codes -------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('pms.ari.read',  'Read ARI inventory grid, rate plans, room types and availability'),
  ('pms.ari.write', 'Mutate ARI inventory: sold units, blocks, stop-sell, rate overrides')
ON CONFLICT (code) DO NOTHING;

-- 2) corporate_admin — full ARI access (manages multiple properties / tenants) -
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'corporate_admin'
   AND p.code IN ('pms.ari.read', 'pms.ari.write')
ON CONFLICT DO NOTHING;

-- 3) property_admin — full ARI access within their property -------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'property_admin'
   AND p.code IN ('pms.ari.read', 'pms.ari.write')
ON CONFLICT DO NOTHING;

-- 4) front_office_manager — read + write ARI (quoting, adjusting sold units,
--    stop-sell during operations) -------------------------------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'front_office_manager'
   AND p.code IN ('pms.ari.read', 'pms.ari.write')
ON CONFLICT DO NOTHING;

-- 5) supervisor / staff — read-only ARI (availability calendar display) -------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code IN ('supervisor', 'staff')
   AND p.code = 'pms.ari.read'
ON CONFLICT DO NOTHING;
