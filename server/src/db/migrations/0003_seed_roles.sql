-- QYRVIA Phase 2 - seed roles + permissions + default matrix.

-- =========================================================================
-- 10 brief-mandated roles, each tagged with scope (adjustment #2).
-- super_admin spans tenants (SYSTEM); corporate/property admin and the
-- functional managers run inside a tenant; operational roles can be granted
-- per-property by setting user_roles.property_id.
-- =========================================================================
INSERT INTO roles (code, name, scope, is_system, description) VALUES
  ('super_admin',          'Super Admin',           'SYSTEM',   true, 'Full system access across all tenants. Bypasses RBAC matrix.'),
  ('corporate_admin',      'Corporate Admin',       'TENANT',   true, 'Full access within one tenant; cannot cross tenant boundaries.'),
  ('property_admin',       'Property Admin',        'PROPERTY', true, 'Full access within one property.'),
  ('finance_manager',      'Finance Manager',       'TENANT',   true, 'AR/AP, journals, periods, banks, fixed assets.'),
  ('front_office_manager', 'Front Office Manager',  'PROPERTY', true, 'Reservations, room assignment, guest folios.'),
  ('hr_manager',           'HR Manager',            'TENANT',   true, 'Employees, leave, payroll, shifts.'),
  ('inventory_manager',    'Inventory Manager',     'PROPERTY', true, 'Inventory, GRN, stock adjustments, PO approval at property level.'),
  ('department_head',      'Department Head',       'PROPERTY', true, 'Leave approval and shift assignment within own department.'),
  ('supervisor',           'Supervisor',            'PROPERTY', true, 'Mostly read access; attendance marking.'),
  ('staff',                'Staff',                 'PROPERTY', true, 'Self-service only.');

-- =========================================================================
-- Permissions (mirrors the QYRVIA_RBAC matrix in the frontend).
-- =========================================================================
INSERT INTO permissions (code, description) VALUES
  -- HR
  ('employee.create',          'Create an employee'),
  ('employee.terminate',       'Mark an employee terminated'),
  ('leave.approve',            'Approve / reject a leave request'),
  ('payroll.run',              'Run payroll for a period'),
  -- Finance
  ('ap.invoice.post',          'Post an accounts-payable invoice'),
  ('ap.payment.create',        'Create an AP payment'),
  ('ar.invoice.create',        'Create an AR invoice'),
  ('journal.post',             'Post a general-journal entry'),
  ('period.close',             'Close a fiscal period'),
  ('period.reopen',            'Reopen a closed fiscal period'),
  -- Inventory + Procurement
  ('grn.receive',              'Receive a Goods Received Note'),
  ('inventory.adjust',         'Adjust inventory levels'),
  ('po.approve',               'Approve a Purchase Order'),
  -- RMS / Reputation / CRM
  ('rms.rate.override',        'Override a room rate'),
  ('reputation.reply',         'Reply to a review'),
  ('crm.guest.merge',          'Merge duplicate guest records'),
  -- Identity / admin
  ('auth.user.create',         'Create a user account'),
  ('auth.user.disable',        'Disable / lock a user account'),
  ('auth.role.grant',          'Grant a role to a user'),
  ('connector.configure',      'Configure an integration connector'),
  ('tests.run',                'Run the in-app test suite');

-- =========================================================================
-- Default role -> permission matrix.
-- Super Admin gets implicit bypass at middleware level (no rows needed).
-- =========================================================================
-- Corporate Admin: every permission within the tenant
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'corporate_admin';

-- Property Admin: every permission EXCEPT cross-tenant identity admin
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'property_admin'
  AND p.code NOT IN ('auth.user.create','auth.user.disable','auth.role.grant');

-- Finance Manager
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'finance_manager'
  AND p.code IN (
    'ap.invoice.post','ap.payment.create','ar.invoice.create',
    'journal.post','period.close','period.reopen'
  );

-- Front Office Manager
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'front_office_manager'
  AND p.code IN ('rms.rate.override','reputation.reply','crm.guest.merge');

-- HR Manager
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'hr_manager'
  AND p.code IN ('employee.create','employee.terminate','leave.approve','payroll.run');

-- Inventory Manager
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'inventory_manager'
  AND p.code IN ('grn.receive','inventory.adjust','po.approve');

-- Department Head
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'department_head'
  AND p.code IN ('leave.approve');

-- Supervisor & Staff: no row-level mutating permissions in Phase 2.
-- They get implicit read access via routes that don't requirePermission.
