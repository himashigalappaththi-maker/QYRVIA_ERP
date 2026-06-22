-- QYRVIA Architecture Hardening (Phase 5.5) - Travel Commerce reservations.
--
-- WHY: Travel Agents, DMCs, Tour Operators, Corporates and Groups require
--      contracts, allocations (negotiated room blocks with release periods),
--      group/tour reservation grouping, and proforma invoicing. Without
--      these tables the Reservation aggregate would have to be redesigned
--      when Group / Tour modules ship. The reservation FK columns are added
--      here so no future ALTER touches the hot reservations table.

-- ============================================================================
-- Reservation groups + series
-- ============================================================================
CREATE TYPE reservation_group_type AS ENUM (
  'GROUP',              -- multiple rooms, one billing party, common arrival
  'TOUR_SERIES',        -- repeating pattern from a tour operator
  'WEDDING',
  'CONFERENCE',
  'OTHER'
);

CREATE TABLE reservation_groups (
  id              UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID                   NOT NULL REFERENCES tenants(id),
  property_id     UUID                   NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  group_type      reservation_group_type NOT NULL,
  code            VARCHAR(40)            NOT NULL,
  name            VARCHAR(200)           NOT NULL,
  holder_guest_id UUID                   REFERENCES guests(id),
  arrival_date    DATE,
  departure_date  DATE,
  total_rooms     INTEGER                NOT NULL DEFAULT 0,
  total_guests    INTEGER                NOT NULL DEFAULT 0,
  cutoff_date     DATE,
  notes           TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ            NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ            NOT NULL DEFAULT now(),
  UNIQUE (property_id, code)
);
ALTER TABLE reservation_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_groups FORCE  ROW LEVEL SECURITY;
CREATE POLICY reservation_groups_by_app ON reservation_groups
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TABLE reservation_series (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  property_id     UUID         NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  code            VARCHAR(40)  NOT NULL,
  name            VARCHAR(200) NOT NULL,
  partner_guest_id UUID        REFERENCES guests(id),   -- TA / DMC / Tour operator
  start_date      DATE,
  end_date        DATE,
  cadence         VARCHAR(40),                          -- WEEKLY/MONTHLY/CUSTOM
  notes           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (property_id, code)
);
ALTER TABLE reservation_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_series FORCE  ROW LEVEL SECURITY;
CREATE POLICY reservation_series_by_app ON reservation_series
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- Reservation -> Group / Series linkage
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS group_id   UUID REFERENCES reservation_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS series_id  UUID REFERENCES reservation_series(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reservations_group  ON reservations(group_id)  WHERE group_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservations_series ON reservations(series_id) WHERE series_id IS NOT NULL;

-- ============================================================================
-- Contracts (Travel Agent / DMC / Corporate negotiated terms)
-- ============================================================================
CREATE TYPE contract_partner_kind AS ENUM ('TRAVEL_AGENT','DMC','CORPORATE','TOUR_ORGANIZER','OTA');

CREATE TYPE contract_status AS ENUM ('DRAFT','ACTIVE','SUSPENDED','EXPIRED','TERMINATED');

CREATE TABLE contracts (
  id                UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID                  NOT NULL REFERENCES tenants(id),
  property_id       UUID                  NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  partner_guest_id  UUID                  REFERENCES guests(id),
  partner_kind      contract_partner_kind NOT NULL,
  code              VARCHAR(40)           NOT NULL,
  name              VARCHAR(200)          NOT NULL,
  status            contract_status       NOT NULL DEFAULT 'DRAFT',
  start_date        DATE                  NOT NULL,
  end_date          DATE                  NOT NULL,
  currency          CHAR(3)               NOT NULL DEFAULT 'LKR',
  payment_terms     VARCHAR(80),
  commission_pct    NUMERIC(5,2),
  credit_limit      NUMERIC(14,2),
  notes             TEXT,
  created_by        UUID,
  created_at        TIMESTAMPTZ           NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ           NOT NULL DEFAULT now(),
  UNIQUE (property_id, code),
  CHECK (end_date > start_date)
);
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts FORCE  ROW LEVEL SECURITY;
CREATE POLICY contracts_by_app ON contracts
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TABLE contract_rates (
  id            UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID            NOT NULL REFERENCES tenants(id),
  contract_id   UUID            NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  room_type_id  UUID            NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
  rate_plan_id  UUID            REFERENCES rate_plans(id) ON DELETE SET NULL,
  date_from     DATE            NOT NULL,
  date_to       DATE            NOT NULL,
  rate          NUMERIC(14,2)   NOT NULL,
  meal_plan     VARCHAR(40),                                -- RO/BB/HB/FB/AI
  notes         TEXT,
  CHECK (date_to >= date_from)
);
CREATE INDEX idx_contract_rates_contract ON contract_rates(contract_id);
ALTER TABLE contract_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_rates FORCE  ROW LEVEL SECURITY;
CREATE POLICY contract_rates_by_app ON contract_rates
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ============================================================================
-- Allocations (room blocks held for a partner with release periods)
-- ============================================================================
CREATE TYPE allocation_status AS ENUM ('ACTIVE','RELEASED','EXHAUSTED','CANCELLED');

CREATE TABLE allocations (
  id              UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID              NOT NULL REFERENCES tenants(id),
  property_id     UUID              NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  contract_id     UUID              REFERENCES contracts(id) ON DELETE SET NULL,
  partner_guest_id UUID             REFERENCES guests(id),
  room_type_id    UUID              NOT NULL REFERENCES room_types(id),
  date_from       DATE              NOT NULL,
  date_to         DATE              NOT NULL,
  qty_blocked     INTEGER           NOT NULL CHECK (qty_blocked >= 0),
  qty_consumed    INTEGER           NOT NULL DEFAULT 0 CHECK (qty_consumed >= 0),
  release_days    INTEGER           NOT NULL DEFAULT 0,
  status          allocation_status NOT NULL DEFAULT 'ACTIVE',
  notes           TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ       NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ       NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from)
);
CREATE INDEX idx_allocations_property_dates ON allocations(property_id, date_from, date_to);
CREATE INDEX idx_allocations_contract ON allocations(contract_id);
ALTER TABLE allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE allocations FORCE  ROW LEVEL SECURITY;
CREATE POLICY allocations_by_app ON allocations
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- Reservation -> Contract linkage (deferred FK to avoid migration ordering)
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS contract_id   UUID REFERENCES contracts(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS allocation_id UUID REFERENCES allocations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reservations_contract   ON reservations(contract_id)   WHERE contract_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservations_allocation ON reservations(allocation_id) WHERE allocation_id IS NOT NULL;

-- ============================================================================
-- Proforma invoices
-- ============================================================================
CREATE TYPE proforma_status AS ENUM ('DRAFT','ISSUED','PAID','CANCELLED','REPLACED');

CREATE TABLE proforma_invoices (
  id               UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID            NOT NULL REFERENCES tenants(id),
  property_id      UUID            NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  reservation_id   UUID            REFERENCES reservations(id) ON DELETE SET NULL,
  group_id         UUID            REFERENCES reservation_groups(id) ON DELETE SET NULL,
  contract_id      UUID            REFERENCES contracts(id) ON DELETE SET NULL,
  number           VARCHAR(40)     NOT NULL,
  status           proforma_status NOT NULL DEFAULT 'DRAFT',
  currency         CHAR(3)         NOT NULL DEFAULT 'LKR',
  total_amount     NUMERIC(14,2)   NOT NULL DEFAULT 0,
  tax_amount       NUMERIC(14,2)   NOT NULL DEFAULT 0,
  issued_at        TIMESTAMPTZ,
  due_at           TIMESTAMPTZ,
  payload          JSONB           NOT NULL DEFAULT '{}'::jsonb,
  created_by       UUID,
  created_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),
  UNIQUE (property_id, number)
);
ALTER TABLE proforma_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE proforma_invoices FORCE  ROW LEVEL SECURITY;
CREATE POLICY proforma_invoices_by_app ON proforma_invoices
  USING (tenant_id::text = current_setting('app.tenant_id', true));
