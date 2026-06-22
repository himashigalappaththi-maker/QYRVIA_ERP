-- QYRVIA Phase 3 - permission seeds for the new kernel surfaces.

INSERT INTO permissions (code, description) VALUES
  ('settings.read',         'Read settings within tenant'),
  ('settings.write',        'Create / update / delete settings'),
  ('files.upload',          'Upload a file'),
  ('files.read',            'Read file metadata / download signed URL'),
  ('files.delete',          'Delete a file (soft delete)'),
  ('webhook.manage',        'Register / disable webhook endpoints, trigger delivery loop'),
  ('jobs.schedule',         'Schedule / cancel / run scheduled jobs'),
  ('notifications.send',    'Request a notification + run send loop'),
  ('notifications.read',    'List / view notifications')
ON CONFLICT (code) DO NOTHING;

-- Grant all Phase 3 surfaces to corporate_admin + property_admin.
-- finance_manager / hr_manager / front_office_manager / inventory_manager
-- get only what they need for their scope.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'corporate_admin'
  AND p.code IN ('settings.read','settings.write','files.upload','files.read','files.delete',
                 'webhook.manage','jobs.schedule','notifications.send','notifications.read')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'property_admin'
  AND p.code IN ('settings.read','settings.write','files.upload','files.read','files.delete',
                 'jobs.schedule','notifications.send','notifications.read')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('finance_manager','hr_manager','front_office_manager','inventory_manager')
  AND p.code IN ('settings.read','files.upload','files.read','notifications.read')
ON CONFLICT DO NOTHING;
