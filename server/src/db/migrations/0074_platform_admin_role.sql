BEGIN;

-- Phase 57: Seed the platform_admin role and its permissions.
--
-- platform_admin is a SYSTEM-scoped role (like super_admin) representing
-- QYRVIA commercial SaaS operators. It carries specific cross-tenant
-- management permissions rather than the full bypass that super_admin holds.
--
-- Separation of concerns:
--   super_admin  — full system bypass, internal engineering / break-glass
--   platform_admin — commercial SaaS operations (tenant onboarding, billing,
--                    invitation management)

INSERT INTO roles (code, name, scope, is_system, description)
VALUES (
    'platform_admin',
    'Platform Administrator',
    'SYSTEM',
    true,
    'QYRVIA commercial SaaS operator — manages tenants, billing, and cross-tenant operations'
)
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions (code, description)
VALUES
    ('tenant.provision', 'Create and configure a new customer tenant organisation'),
    ('tenant.read',      'Read tenant configuration, subscription status, and audit summary'),
    ('tenant.suspend',   'Suspend or reactivate a customer tenant'),
    ('invitation.create.any', 'Issue user invitations across any tenant'),
    ('invitation.revoke.any', 'Revoke user invitations across any tenant')
ON CONFLICT (code) DO NOTHING;

-- Grant all five permissions to platform_admin.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
 CROSS JOIN permissions p
 WHERE r.code = 'platform_admin'
   AND p.code IN (
       'tenant.provision',
       'tenant.read',
       'tenant.suspend',
       'invitation.create.any',
       'invitation.revoke.any'
   )
ON CONFLICT DO NOTHING;

COMMIT;
