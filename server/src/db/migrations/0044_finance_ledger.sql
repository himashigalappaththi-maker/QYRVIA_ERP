-- QYRVIA Phase 8 - Ledger Foundation (minimal double-entry backbone).
--
-- WHY: Phase 7 gave us transactional finance (folios, invoices, payments,
-- vouchers). Phase 8 makes it accounting-grade: every financial mutation
-- MUST resolve into a BALANCED set of ledger entries (SUM debit == SUM
-- credit) or it is rejected. Entries are grouped into a batch; a batch is
-- the unit that must balance.
--
-- This is intentionally a *minimal* ledger (not a full chart-of-accounts
-- GL - that is the reserved finance_ledger_accounts / finance_journal_entries
-- layer from migration 0029). Here each entry is ONE-SIDED: it carries
-- EITHER a debit_amount OR a credit_amount against a free-text account_code
-- that is resolved from the revenue_posting_map (C12). No hardcoded account
-- names live in services.

-- A batch groups the entries of a single financial event. The batch row is
-- the balance unit and the reversal anchor.
CREATE TABLE ledger_batches (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID          NOT NULL REFERENCES tenants(id),
  property_id           UUID          NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  entry_type            VARCHAR(40)   NOT NULL,   -- INVOICE, PAYMENT, VOUCHER, ADJUSTMENT, REVERSAL
  reference_type        VARCHAR(60)   NOT NULL,   -- invoice, payment_allocation, voucher, ledger_batch, ...
  reference_id          UUID          NOT NULL,
  currency              VARCHAR(8)    NOT NULL DEFAULT 'LKR',
  total_debit           NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_credit          NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by            UUID,
  reverted_at           TIMESTAMPTZ,
  reverted_by_batch_id  UUID REFERENCES ledger_batches(id) ON DELETE SET NULL,
  -- The batch itself must balance.
  CONSTRAINT ledger_batch_balanced CHECK (total_debit = total_credit)
);
CREATE INDEX idx_ledger_batches_reference ON ledger_batches(tenant_id, reference_type, reference_id);
CREATE INDEX idx_ledger_batches_property  ON ledger_batches(tenant_id, property_id, created_at);

CREATE TABLE ledger_entries (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID          NOT NULL REFERENCES tenants(id),
  property_id     UUID          NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  batch_id        UUID          NOT NULL REFERENCES ledger_batches(id) ON DELETE RESTRICT,
  entry_type      VARCHAR(40)   NOT NULL,   -- mirrors the batch entry_type
  reference_type  VARCHAR(60)   NOT NULL,
  reference_id    UUID          NOT NULL,
  cost_center_id  UUID          REFERENCES cost_centers(id) ON DELETE SET NULL,
  account_code    VARCHAR(60)   NOT NULL,   -- resolved from revenue_posting_map (no hardcoded accounts)
  debit_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency        VARCHAR(8)    NOT NULL DEFAULT 'LKR',
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- No orphan entries: every entry is anchored to a batch (FK above) and a
  -- domain reference (reference_type + reference_id).
  CONSTRAINT ledger_entry_nonneg     CHECK (debit_amount >= 0 AND credit_amount >= 0),
  -- Each entry is strictly one-sided (a leg of the double entry).
  CONSTRAINT ledger_entry_one_sided  CHECK ((debit_amount = 0) OR (credit_amount = 0))
);
CREATE INDEX idx_ledger_entries_reference ON ledger_entries(tenant_id, reference_type, reference_id);
CREATE INDEX idx_ledger_entries_batch     ON ledger_entries(batch_id);
CREATE INDEX idx_ledger_entries_cc        ON ledger_entries(tenant_id, property_id, cost_center_id);

-- Tenant isolation.
ALTER TABLE ledger_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_batches FORCE  ROW LEVEL SECURITY;
CREATE POLICY ledger_batches_by_app ON ledger_batches
  USING (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE  ROW LEVEL SECURITY;
CREATE POLICY ledger_entries_by_app ON ledger_entries
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- Ledger entries are append-only: corrections are made by posting a
-- REVERSAL batch, never by mutating history.
REVOKE UPDATE, DELETE ON ledger_entries FROM PUBLIC;

INSERT INTO permissions (code, description) VALUES
  ('ledger.read',   'Read ledger entries, batches and finance reports'),
  ('ledger.write',  'Post ledger batches'),
  ('ledger.revert', 'Revert (reverse) a posted ledger batch - admin only')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('corporate_admin','property_admin')
  AND p.code IN ('ledger.read','ledger.write')
ON CONFLICT DO NOTHING;

-- ledger.revert is a privileged operation: corporate_admin only.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'corporate_admin'
  AND p.code = 'ledger.revert'
ON CONFLICT DO NOTHING;
