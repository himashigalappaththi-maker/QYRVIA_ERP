-- QYRVIA Phase 8 / C11 - Cost Center system.
--
-- WHY: Every revenue-bearing transaction must map to a cost center for
-- accounting reporting (per-CC P&L, per-CC budgeting). The cost_center_id
-- columns are NULLABLE at the SCHEMA level to preserve compatibility with
-- pre-Phase-8 rows, but Phase 8 commands require them at the COMMAND level
-- (any new invoice / voucher redemption / payment allocation will fail
-- without one).

CREATE TYPE cost_center_type AS ENUM ('ROOM','FNB','SPA','ADMIN','OTHER');

CREATE TABLE cost_centers (
  id          UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID             NOT NULL REFERENCES tenants(id),
  property_id UUID             NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  code        VARCHAR(40)      NOT NULL,
  name        VARCHAR(200)     NOT NULL,
  type        cost_center_type NOT NULL,
  description TEXT,
  is_active   BOOLEAN          NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ      NOT NULL DEFAULT now(),
  created_by  UUID,
  UNIQUE (tenant_id, property_id, code)
);
CREATE INDEX idx_cost_centers_property ON cost_centers(tenant_id, property_id);

ALTER TABLE cost_centers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_centers FORCE  ROW LEVEL SECURITY;
CREATE POLICY cost_centers_by_app ON cost_centers
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- Attach cost_center_id (nullable for BC) to the revenue-bearing entities.
ALTER TABLE invoices             ADD COLUMN IF NOT EXISTS cost_center_id UUID REFERENCES cost_centers(id) ON DELETE SET NULL;
ALTER TABLE folio_lines          ADD COLUMN IF NOT EXISTS cost_center_id UUID REFERENCES cost_centers(id) ON DELETE SET NULL;
ALTER TABLE vouchers             ADD COLUMN IF NOT EXISTS cost_center_id UUID REFERENCES cost_centers(id) ON DELETE SET NULL;
ALTER TABLE payment_allocations  ADD COLUMN IF NOT EXISTS cost_center_id UUID REFERENCES cost_centers(id) ON DELETE SET NULL;

INSERT INTO permissions (code, description) VALUES
  ('cost_center.read',  'Read cost centers'),
  ('cost_center.write', 'Create / update / disable cost centers')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('corporate_admin','property_admin')
  AND p.code IN ('cost_center.read','cost_center.write')
ON CONFLICT DO NOTHING;
