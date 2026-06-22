-- QYRVIA Phase 5 - PMS permission seeds.

INSERT INTO permissions (code, description) VALUES
  ('pms.roomtype.read',     'Read room types'),
  ('pms.roomtype.write',    'Create / update room types'),
  ('pms.room.read',         'Read rooms'),
  ('pms.room.write',        'Create / update / status-change rooms'),
  ('pms.feature.read',      'Read room features'),
  ('pms.feature.write',     'Create / update room features'),
  ('pms.building.write',    'Create / update buildings and floors'),
  ('pms.guest.read',        'Read guests'),
  ('pms.guest.write',       'Create / update / blacklist guests'),
  ('pms.childpolicy.read',  'Read child policies'),
  ('pms.childpolicy.write', 'Create / update child policies + age categories'),
  ('pms.reservation.read',  'Read reservations'),
  ('pms.reservation.write', 'Create / confirm / cancel / no-show reservations'),
  ('pms.rateplan.read',     'Read rate plans'),
  ('pms.rateplan.write',    'Create / update rate plans + pricing'),
  ('pms.availability.read', 'Read availability calendar')
ON CONFLICT (code) DO NOTHING;

-- corporate_admin gets everything PMS
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'corporate_admin' AND p.code LIKE 'pms.%'
ON CONFLICT DO NOTHING;

-- property_admin gets everything PMS at property level
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'property_admin' AND p.code LIKE 'pms.%'
ON CONFLICT DO NOTHING;

-- Front Office Manager: rooms/guests/reservations/availability + read on the rest
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'front_office_manager'
  AND p.code IN (
    'pms.room.read','pms.room.write','pms.roomtype.read','pms.feature.read',
    'pms.guest.read','pms.guest.write',
    'pms.reservation.read','pms.reservation.write',
    'pms.availability.read','pms.rateplan.read','pms.childpolicy.read'
  )
ON CONFLICT DO NOTHING;

-- Supervisor / Staff: read-only on guests + reservations + availability
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('supervisor','staff')
  AND p.code IN ('pms.guest.read','pms.reservation.read','pms.availability.read','pms.room.read')
ON CONFLICT DO NOTHING;
