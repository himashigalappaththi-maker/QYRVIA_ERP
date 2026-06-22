-- QYRVIA Phase 7 / C9 - Invoice aggregate.
--
-- WHY: A folio is internal-only; an invoice is the fiscal artifact that
-- jurisdictions require be sequentially numbered, non-deletable, and
-- voidable only with a reason. Invoice is issued FROM a folio (1:1 in
-- v1; future splits will be 1:N). Folio.balance must be zero to issue
-- a SETTLED-status invoice.

CREATE TYPE invoice_status AS ENUM ('DRAFT','ISSUED','PAID','VOIDED','REPLACED');

CREATE TABLE invoices (
  id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID            NOT NULL REFERENCES tenants(id),
  property_id       UUID            NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  folio_id          UUID            NOT NULL REFERENCES folios(id) ON DELETE RESTRICT,
  invoice_number    VARCHAR(40)     NOT NULL,
  status            invoice_status  NOT NULL DEFAULT 'ISSUED',
  currency          CHAR(3)         NOT NULL DEFAULT 'LKR',
  issued_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),
  paid_at           TIMESTAMPTZ,
  voided_at         TIMESTAMPTZ,
  void_reason       TEXT,
  total_amount      NUMERIC(14,2)   NOT NULL DEFAULT 0,
  tax_amount        NUMERIC(14,2)   NOT NULL DEFAULT 0,
  balance           NUMERIC(14,2)   NOT NULL DEFAULT 0,
  bill_to_guest_id  UUID            REFERENCES guests(id),
  business_date     DATE,
  payload           JSONB           NOT NULL DEFAULT '{}'::jsonb,
  created_by        UUID,
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_invoices_number ON invoices(property_id, invoice_number);
CREATE INDEX idx_invoices_folio ON invoices(folio_id);
CREATE INDEX idx_invoices_tenant_status ON invoices(tenant_id, status);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE  ROW LEVEL SECURITY;
CREATE POLICY invoices_by_app ON invoices
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TABLE invoice_counters (
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  property_id  UUID         NOT NULL REFERENCES properties(id),
  year         INTEGER      NOT NULL,
  next_number  INTEGER      NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, year)
);
ALTER TABLE invoice_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_counters FORCE  ROW LEVEL SECURITY;
CREATE POLICY invoice_counters_by_app ON invoice_counters
  USING (tenant_id::text = current_setting('app.tenant_id', true));

INSERT INTO permissions (code, description) VALUES
  ('invoice.read',  'Read invoices'),
  ('invoice.write', 'Issue an invoice from a folio'),
  ('invoice.void',  'Void an issued invoice')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('corporate_admin','property_admin','front_office_manager')
  AND p.code IN ('invoice.read','invoice.write','invoice.void')
ON CONFLICT DO NOTHING;
