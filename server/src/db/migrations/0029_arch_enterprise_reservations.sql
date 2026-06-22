-- QYRVIA Architecture Hardening (Phase 5.5) - Enterprise Platform reserved
-- tables (CRM, Loyalty, HR, Payroll, Finance, Procurement, Inventory,
-- Fixed Assets, Gate Pass, BI).
--
-- WHY: Each of these subsystems is a future phase; we are NOT implementing
--      them now. But the persistence keys they will join to live in PMS:
--      guests, properties, tenants, reservations, folios, rooms.
--      Reserving the shape now prevents painful breaking migrations later.
--      Tables are intentionally MINIMAL - just enough to anchor the FKs.

-- ============================================================================
-- CRM
-- ============================================================================
CREATE TYPE crm_interaction_kind AS ENUM (
  'CALL','EMAIL','MEETING','WHATSAPP','SMS','VISIT','TASK','NOTE','COMPLAINT','OTHER'
);

CREATE TABLE crm_interactions (
  id              UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID                  NOT NULL REFERENCES tenants(id),
  property_id     UUID                  REFERENCES properties(id) ON DELETE SET NULL,
  guest_id        UUID                  REFERENCES guests(id) ON DELETE CASCADE,
  reservation_id  UUID                  REFERENCES reservations(id) ON DELETE SET NULL,
  kind            crm_interaction_kind  NOT NULL,
  subject         VARCHAR(200),
  body            TEXT,
  outcome         VARCHAR(80),
  follow_up_at    TIMESTAMPTZ,
  actor_user_id   UUID,
  occurred_at     TIMESTAMPTZ           NOT NULL DEFAULT now(),
  payload         JSONB                 NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_crm_guest_time ON crm_interactions(guest_id, occurred_at DESC);
ALTER TABLE crm_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_interactions FORCE  ROW LEVEL SECURITY;
CREATE POLICY crm_by_app ON crm_interactions
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ============================================================================
-- Loyalty
-- ============================================================================
CREATE TABLE loyalty_accounts (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  guest_id        UUID         NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  account_number  VARCHAR(40)  NOT NULL,
  tier            VARCHAR(40),
  points_balance  INTEGER      NOT NULL DEFAULT 0,
  lifetime_points INTEGER      NOT NULL DEFAULT 0,
  enrolled_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  status          VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, account_number),
  UNIQUE (tenant_id, guest_id)
);
ALTER TABLE loyalty_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_accounts FORCE  ROW LEVEL SECURITY;
CREATE POLICY loyalty_acc_by_app ON loyalty_accounts
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TYPE loyalty_tx_kind AS ENUM ('EARN','REDEEM','ADJUST','EXPIRE','TRANSFER');

CREATE TABLE loyalty_transactions (
  id              UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID             NOT NULL REFERENCES tenants(id),
  account_id      UUID             NOT NULL REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
  reservation_id  UUID             REFERENCES reservations(id) ON DELETE SET NULL,
  folio_id        UUID             REFERENCES folios(id) ON DELETE SET NULL,
  kind            loyalty_tx_kind  NOT NULL,
  points          INTEGER          NOT NULL,
  description     VARCHAR(200),
  business_date   DATE,
  occurred_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),
  payload         JSONB            NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_loyalty_tx_account ON loyalty_transactions(account_id, occurred_at DESC);
ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_transactions FORCE  ROW LEVEL SECURITY;
CREATE POLICY loyalty_tx_by_app ON loyalty_transactions
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ============================================================================
-- HR / Payroll
-- ============================================================================
CREATE TABLE hr_employees (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  property_id     UUID         REFERENCES properties(id) ON DELETE SET NULL,
  employee_code   VARCHAR(40)  NOT NULL,
  user_id         UUID,                                    -- link to users(id) when system access exists
  first_name      VARCHAR(120) NOT NULL,
  last_name       VARCHAR(120),
  email           VARCHAR(200),
  mobile          VARCHAR(40),
  designation     VARCHAR(120),
  department      VARCHAR(80),
  hire_date       DATE,
  termination_date DATE,
  status          VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_code)
);
ALTER TABLE hr_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_employees FORCE  ROW LEVEL SECURITY;
CREATE POLICY hr_emp_by_app ON hr_employees
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TABLE payroll_periods (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id),
  property_id   UUID         REFERENCES properties(id) ON DELETE SET NULL,
  code          VARCHAR(40)  NOT NULL,
  period_start  DATE         NOT NULL,
  period_end    DATE         NOT NULL,
  status        VARCHAR(20)  NOT NULL DEFAULT 'OPEN',
  closed_at     TIMESTAMPTZ,
  UNIQUE (tenant_id, code)
);
ALTER TABLE payroll_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_periods FORCE  ROW LEVEL SECURITY;
CREATE POLICY payroll_periods_by_app ON payroll_periods
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ============================================================================
-- Finance ledger
-- ============================================================================
CREATE TABLE finance_ledger_accounts (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  property_id     UUID         REFERENCES properties(id) ON DELETE SET NULL,
  code            VARCHAR(40)  NOT NULL,
  name            VARCHAR(200) NOT NULL,
  account_type    VARCHAR(40)  NOT NULL,     -- 'ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE'
  active          BOOLEAN      NOT NULL DEFAULT true,
  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, code)
);
ALTER TABLE finance_ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_ledger_accounts FORCE  ROW LEVEL SECURITY;
CREATE POLICY fin_la_by_app ON finance_ledger_accounts
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TABLE finance_journal_entries (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  property_id     UUID         REFERENCES properties(id) ON DELETE SET NULL,
  account_id      UUID         NOT NULL REFERENCES finance_ledger_accounts(id),
  business_date   DATE         NOT NULL,
  debit_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  description     TEXT,
  source_module   VARCHAR(40),     -- 'FOLIO','POS','PAYROLL','PROCUREMENT'
  source_ref      VARCHAR(120),
  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_fje_account_date ON finance_journal_entries(account_id, business_date);
CREATE INDEX idx_fje_source ON finance_journal_entries(source_module, source_ref);
ALTER TABLE finance_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_journal_entries FORCE  ROW LEVEL SECURITY;
CREATE POLICY fje_by_app ON finance_journal_entries
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ============================================================================
-- Procurement
-- ============================================================================
CREATE TYPE po_status AS ENUM ('DRAFT','APPROVED','SENT','PARTIAL','RECEIVED','CANCELLED','CLOSED');

CREATE TABLE procurement_purchase_orders (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  property_id     UUID         NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  po_number       VARCHAR(40)  NOT NULL,
  supplier_id     UUID,                                  -- references guests(id) when guest_type='CORPORATE'
  status          po_status    NOT NULL DEFAULT 'DRAFT',
  currency        CHAR(3)      NOT NULL DEFAULT 'LKR',
  total_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  ordered_at      TIMESTAMPTZ,
  expected_at     TIMESTAMPTZ,
  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_by      UUID,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (property_id, po_number)
);
ALTER TABLE procurement_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_purchase_orders FORCE  ROW LEVEL SECURITY;
CREATE POLICY po_by_app ON procurement_purchase_orders
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ============================================================================
-- Inventory
-- ============================================================================
CREATE TABLE inventory_items (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  property_id     UUID         REFERENCES properties(id) ON DELETE SET NULL,
  sku             VARCHAR(40)  NOT NULL,
  name            VARCHAR(200) NOT NULL,
  unit            VARCHAR(20),                          -- 'EA','KG','L'
  category        VARCHAR(80),
  reorder_level   NUMERIC(14,2) NOT NULL DEFAULT 0,
  active          BOOLEAN      NOT NULL DEFAULT true,
  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, sku)
);
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items FORCE  ROW LEVEL SECURITY;
CREATE POLICY inv_items_by_app ON inventory_items
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TABLE inventory_stock_levels (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID            NOT NULL REFERENCES tenants(id),
  property_id     UUID            NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  item_id         UUID            NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  location_code   VARCHAR(40)     NOT NULL DEFAULT 'MAIN',
  quantity        NUMERIC(14,3)   NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
  UNIQUE (item_id, location_code, property_id)
);
ALTER TABLE inventory_stock_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_stock_levels FORCE  ROW LEVEL SECURITY;
CREATE POLICY inv_stock_by_app ON inventory_stock_levels
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ============================================================================
-- Fixed Assets
-- ============================================================================
CREATE TABLE fixed_assets (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  property_id     UUID         REFERENCES properties(id) ON DELETE SET NULL,
  asset_tag       VARCHAR(40)  NOT NULL,
  name            VARCHAR(200) NOT NULL,
  category        VARCHAR(80),
  acquired_at     DATE,
  acquired_cost   NUMERIC(14,2) NOT NULL DEFAULT 0,
  current_value   NUMERIC(14,2) NOT NULL DEFAULT 0,
  status          VARCHAR(20)  NOT NULL DEFAULT 'IN_USE',
  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, asset_tag)
);
ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_assets FORCE  ROW LEVEL SECURITY;
CREATE POLICY fa_by_app ON fixed_assets
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ============================================================================
-- Gate Pass / Security
-- ============================================================================
CREATE TABLE gate_passes (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  property_id     UUID         NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  pass_number     VARCHAR(40)  NOT NULL,
  kind            VARCHAR(40)  NOT NULL,                  -- 'VEHICLE','MATERIAL','PERSON','VENDOR'
  purpose         VARCHAR(200),
  issued_to_name  VARCHAR(200),
  vehicle_no      VARCHAR(40),
  status          VARCHAR(20)  NOT NULL DEFAULT 'ISSUED', -- 'ISSUED','EXITED','RETURNED','CANCELLED'
  issued_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  exited_at       TIMESTAMPTZ,
  returned_at     TIMESTAMPTZ,
  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (property_id, pass_number)
);
ALTER TABLE gate_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE gate_passes FORCE  ROW LEVEL SECURITY;
CREATE POLICY gp_by_app ON gate_passes
  USING (tenant_id::text = current_setting('app.tenant_id', true));
