-- QYRVIA Phase 8 / C12 - Revenue Posting Map.
--
-- WHY: We refuse to hardcode debit/credit account names inside services.
-- Every financial event (invoice.issued, folio.payment_allocated,
-- voucher.redeemed, etc.) MUST resolve through this map. Missing mapping
-- is a HARD FAIL (no fallback) - this is the core integrity guarantee
-- of Phase 8.

CREATE TABLE revenue_posting_map (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID            NOT NULL REFERENCES tenants(id),
  property_id     UUID            NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  event_type      VARCHAR(80)     NOT NULL,
  revenue_type    VARCHAR(40)     NOT NULL,    -- ROOM_REVENUE, FNB_REVENUE, SPA_REVENUE, DISCOUNT_OR_AGENT_COST, PAYMENT_RECEIPT, ...
  cost_center_id  UUID            REFERENCES cost_centers(id) ON DELETE SET NULL,
  debit_account   VARCHAR(60)     NOT NULL,
  credit_account  VARCHAR(60)     NOT NULL,
  is_active       BOOLEAN         NOT NULL DEFAULT true,
  description     TEXT,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
  created_by      UUID,
  UNIQUE (tenant_id, property_id, event_type)
);
CREATE INDEX idx_revenue_map_lookup ON revenue_posting_map(tenant_id, property_id, event_type)
  WHERE is_active = true;

ALTER TABLE revenue_posting_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_posting_map FORCE  ROW LEVEL SECURITY;
CREATE POLICY rev_map_by_app ON revenue_posting_map
  USING (tenant_id::text = current_setting('app.tenant_id', true));

INSERT INTO permissions (code, description) VALUES
  ('revenue_map.read',  'Read revenue posting map'),
  ('revenue_map.write', 'Create / update / delete revenue posting map entries')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('corporate_admin','property_admin')
  AND p.code IN ('revenue_map.read','revenue_map.write')
ON CONFLICT DO NOTHING;
