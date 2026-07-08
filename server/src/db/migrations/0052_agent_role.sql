-- Phase 46B: Add agent/DMC role and link to pre-seeded permissions.
-- Additive only — no destructive changes.

-- 1. Add agent role (PROPERTY scope, not is_system so tenants can configure it)
INSERT INTO roles (code, name, scope, is_system, description)
VALUES (
  'agent',
  'Agent/DMC',
  'PROPERTY',
  false,
  'Travel agent or DMC representative. Scoped to own gate passes and room-service orders only.'
)
ON CONFLICT (code) DO NOTHING;

-- 2. Grant gatepass + POS read/write permissions to agent role
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'agent'
   AND p.code IN ('gatepass.read', 'gatepass.write', 'pos.order.read', 'pos.order.write')
ON CONFLICT DO NOTHING;

-- 3. Add optional external agent-id field to users
--    (links the ERP user to the channel-manager agent record; nullable)
ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_id TEXT;
