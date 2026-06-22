-- QYRVIA Phase 7 / C8 - Payment Allocation.
--
-- WHY: A folio_lines PAYMENT row records "guest paid X". Without
-- allocation, we cannot answer "which charge is the payment against?",
-- which means AR aging is unreliable for corporate / agent guests and
-- partial-pay scenarios cannot be modelled.

CREATE TABLE payment_allocations (
  id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID            NOT NULL REFERENCES tenants(id),
  folio_id          UUID            NOT NULL REFERENCES folios(id) ON DELETE CASCADE,
  payment_line_id   UUID            NOT NULL REFERENCES folio_lines(id) ON DELETE CASCADE,
  charge_line_id    UUID            NOT NULL REFERENCES folio_lines(id) ON DELETE CASCADE,
  amount_allocated  NUMERIC(14,2)   NOT NULL CHECK (amount_allocated > 0),
  allocated_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
  allocated_by      UUID,
  business_date     DATE
);
CREATE INDEX idx_pa_payment ON payment_allocations(payment_line_id);
CREATE INDEX idx_pa_charge  ON payment_allocations(charge_line_id);
CREATE INDEX idx_pa_folio   ON payment_allocations(folio_id);

ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations FORCE  ROW LEVEL SECURITY;
CREATE POLICY pa_by_app ON payment_allocations
  USING (tenant_id::text = current_setting('app.tenant_id', true));

INSERT INTO permissions (code, description) VALUES
  ('folio.allocate.read', 'Read payment allocations on a folio')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('corporate_admin','property_admin','front_office_manager')
  AND p.code = 'folio.allocate.read'
ON CONFLICT DO NOTHING;
