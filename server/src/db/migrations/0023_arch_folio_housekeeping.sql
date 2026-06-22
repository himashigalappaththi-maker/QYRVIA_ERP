-- QYRVIA Architecture Hardening (Phase 5.5) - Folio + Housekeeping skeleton.
--
-- WHY: Check-In requires an OPEN folio. Check-Out requires a CLOSED folio.
--      Housekeeping work orders flow off reservations + room status. The
--      tables below are minimal-but-correct: keys, FKs, RLS, enums.
--      Business behaviour (deposits, taxes, splits) lands in later phases,
--      but the persistence shape will not change.

-- ============================================================================
-- Folios
-- ============================================================================
CREATE TYPE folio_status AS ENUM ('OPEN', 'SETTLED', 'CLOSED', 'VOIDED');

CREATE TYPE folio_charge_type AS ENUM (
  'ROOM',         -- nightly room charge
  'ROOM_TAX',
  'PACKAGE',
  'EXTRA_BED',
  'MINIBAR',
  'POS_CHARGE',   -- posted from restaurant/bar POS
  'LAUNDRY',
  'TELEPHONE',
  'INTERNET',
  'SPA',
  'TRANSFER',
  'MISC',
  'PAYMENT',      -- guest payment / settlement
  'REFUND',
  'ADJUSTMENT',
  'DEPOSIT'
);

CREATE TABLE folios (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID         NOT NULL REFERENCES tenants(id),
  property_id      UUID         NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  reservation_id   UUID         REFERENCES reservations(id) ON DELETE SET NULL,
  folio_number     VARCHAR(40)  NOT NULL,
  status           folio_status NOT NULL DEFAULT 'OPEN',
  currency         CHAR(3)      NOT NULL DEFAULT 'LKR',
  guest_id         UUID         REFERENCES guests(id),
  opened_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  closed_at        TIMESTAMPTZ,
  business_date    DATE,
  total_charges    NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_payments   NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance          NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_by       UUID,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_folios_number ON folios(property_id, folio_number);
CREATE INDEX idx_folios_tenant_status ON folios(tenant_id, status);
CREATE INDEX idx_folios_reservation ON folios(reservation_id) WHERE reservation_id IS NOT NULL;

ALTER TABLE folios ENABLE ROW LEVEL SECURITY;
ALTER TABLE folios FORCE  ROW LEVEL SECURITY;
CREATE POLICY folios_by_app ON folios
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TABLE folio_lines (
  id              UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID              NOT NULL REFERENCES tenants(id),
  folio_id        UUID              NOT NULL REFERENCES folios(id) ON DELETE CASCADE,
  charge_type     folio_charge_type NOT NULL,
  description     VARCHAR(400),
  quantity        NUMERIC(10,2)     NOT NULL DEFAULT 1,
  unit_amount     NUMERIC(14,2)     NOT NULL DEFAULT 0,
  amount          NUMERIC(14,2)     NOT NULL DEFAULT 0,   -- signed (payments < 0 by convention)
  tax_amount      NUMERIC(14,2)     NOT NULL DEFAULT 0,
  business_date   DATE              NOT NULL,
  posted_at       TIMESTAMPTZ       NOT NULL DEFAULT now(),
  posted_by       UUID,
  reversed_line_id UUID             REFERENCES folio_lines(id),
  source_module   VARCHAR(40),                            -- 'PMS', 'POS', 'CHANNEL', etc.
  source_ref      VARCHAR(120),                           -- external id from source module
  metadata        JSONB             NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_folio_lines_folio ON folio_lines(folio_id);
CREATE INDEX idx_folio_lines_tenant_busdate ON folio_lines(tenant_id, business_date);
CREATE INDEX idx_folio_lines_source ON folio_lines(source_module, source_ref) WHERE source_ref IS NOT NULL;

ALTER TABLE folio_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE folio_lines FORCE  ROW LEVEL SECURITY;
CREATE POLICY folio_lines_by_app ON folio_lines
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ============================================================================
-- Housekeeping
-- ============================================================================
CREATE TYPE hk_task_type AS ENUM (
  'CLEAN_DEPARTURE',
  'CLEAN_STAYOVER',
  'INSPECT',
  'LINEN_CHANGE',
  'TURNDOWN',
  'DEEP_CLEAN',
  'MAINTENANCE',
  'LOST_AND_FOUND',
  'OTHER'
);

CREATE TYPE hk_task_status AS ENUM (
  'PENDING','ASSIGNED','IN_PROGRESS','COMPLETED','VERIFIED','CANCELLED'
);

CREATE TABLE housekeeping_tasks (
  id               UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID            NOT NULL REFERENCES tenants(id),
  property_id      UUID            NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  room_id          UUID            REFERENCES rooms(id) ON DELETE SET NULL,
  reservation_id   UUID            REFERENCES reservations(id) ON DELETE SET NULL,
  task_type        hk_task_type    NOT NULL,
  status           hk_task_status  NOT NULL DEFAULT 'PENDING',
  priority         SMALLINT        NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  scheduled_for    DATE,
  assigned_to      UUID,                                  -- references users(id) when present
  assigned_at      TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  verified_at      TIMESTAMPTZ,
  verified_by      UUID,
  notes            TEXT,
  created_by       UUID,
  created_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ     NOT NULL DEFAULT now()
);
CREATE INDEX idx_hk_property_status ON housekeeping_tasks(property_id, status);
CREATE INDEX idx_hk_room ON housekeeping_tasks(room_id);
CREATE INDEX idx_hk_assigned ON housekeeping_tasks(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX idx_hk_scheduled ON housekeeping_tasks(property_id, scheduled_for);

ALTER TABLE housekeeping_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE housekeeping_tasks FORCE  ROW LEVEL SECURITY;
CREATE POLICY hk_tasks_by_app ON housekeeping_tasks
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ============================================================================
-- Per-property per-year folio counter
-- ============================================================================
CREATE TABLE folio_counters (
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  property_id  UUID         NOT NULL REFERENCES properties(id),
  year         INTEGER      NOT NULL,
  next_number  INTEGER      NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, year)
);

ALTER TABLE folio_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE folio_counters FORCE  ROW LEVEL SECURITY;
CREATE POLICY folio_counters_by_app ON folio_counters
  USING (tenant_id::text = current_setting('app.tenant_id', true));
