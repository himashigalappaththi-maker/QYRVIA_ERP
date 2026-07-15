-- Phase 59: Incident, Maintenance, and Attendance permission codes.
-- Additive: uses ON CONFLICT DO NOTHING everywhere.

INSERT INTO permissions (code, description) VALUES
  -- ---- Incident Reporting ------------------------------------------------
  ('incident.read',    'View incident reports for the property'),
  ('incident.create',  'Submit a new incident report'),
  ('incident.assign',  'Assign an incident to a staff member'),
  ('incident.update',  'Update incident details or action taken'),
  ('incident.resolve', 'Resolve / close an incident'),

  -- ---- Maintenance Work Orders -------------------------------------------
  ('maintenance.read',     'View maintenance work orders'),
  ('maintenance.create',   'Create a new maintenance work order'),
  ('maintenance.assign',   'Assign a work order to a technician'),
  ('maintenance.update',   'Update work order details or priority'),
  ('maintenance.complete', 'Mark a work order as completed'),

  -- ---- Attendance --------------------------------------------------------
  ('attendance.read',   'View own attendance events'),
  ('attendance.record', 'Record a check-in or check-out event'),
  ('attendance.manage', 'View and manage all staff attendance events')

ON CONFLICT (code) DO NOTHING;

-- corporate_admin and property_admin inherit all new permissions.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code IN ('corporate_admin', 'property_admin')
   AND p.code IN (
     'incident.read', 'incident.create', 'incident.assign',
     'incident.update', 'incident.resolve',
     'maintenance.read', 'maintenance.create', 'maintenance.assign',
     'maintenance.update', 'maintenance.complete',
     'attendance.read', 'attendance.record', 'attendance.manage'
   )
ON CONFLICT DO NOTHING;

-- front_office_manager: read incidents, read maintenance, manage attendance
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r CROSS JOIN permissions p
 WHERE r.code = 'front_office_manager'
   AND p.code IN (
     'incident.read', 'maintenance.read',
     'attendance.read', 'attendance.record', 'attendance.manage'
   )
ON CONFLICT DO NOTHING;
