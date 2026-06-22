-- QYRVIA Phase 5 - Reservation Aggregate + Reservation Number Generator.

CREATE TYPE reservation_type AS ENUM (
  'INDIVIDUAL', 'GROUP', 'CORPORATE', 'AGENT', 'DMC', 'TOUR'
);

CREATE TYPE reservation_status AS ENUM (
  'INQUIRY', 'OPTION', 'CONFIRMED', 'CANCELLED', 'NO_SHOW'
);

-- Per-property per-year counter for reservation numbers
-- Format: PROPERTYCODE-YYYY-NNNNNN (zero-padded to 6 digits)
CREATE TABLE reservation_counters (
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  property_id  UUID         NOT NULL REFERENCES properties(id),
  year         INTEGER      NOT NULL,
  next_number  INTEGER      NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, year)
);

ALTER TABLE reservation_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_counters FORCE  ROW LEVEL SECURITY;
CREATE POLICY reservation_counters_by_app ON reservation_counters
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TABLE reservations (
  id                      UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID             NOT NULL REFERENCES tenants(id),
  property_id             UUID             NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  reservation_number      VARCHAR(40)      NOT NULL,
  reservation_type        reservation_type NOT NULL,
  status                  reservation_status NOT NULL DEFAULT 'INQUIRY',
  -- Holder: MUST be an Adult Guest, Company, Agent, DMC, or Tour - enforced
  -- by the reservation.create command (refuses guest of unsupported type).
  holder_guest_id         UUID             NOT NULL REFERENCES guests(id) ON DELETE RESTRICT,
  primary_adult_guest_id  UUID             NOT NULL REFERENCES guests(id) ON DELETE RESTRICT,
  arrival_date            DATE             NOT NULL,
  departure_date          DATE             NOT NULL,
  nights                  INTEGER          GENERATED ALWAYS AS ((departure_date - arrival_date)) STORED,
  adults                  INTEGER          NOT NULL DEFAULT 1,
  children                INTEGER          NOT NULL DEFAULT 0,
  room_type_id            UUID             NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
  rate_plan_id            UUID,                      -- FK added in 0020 after rate_plans table exists
  rooms_count             INTEGER          NOT NULL DEFAULT 1,
  notes                   TEXT,
  cancelled_at            TIMESTAMPTZ,
  cancellation_reason     TEXT,
  business_date           DATE,                      -- copied from property at create time
  created_at              TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ      NOT NULL DEFAULT now(),
  created_by              UUID,
  CHECK (adults   >= 1),
  CHECK (children >= 0),
  CHECK (departure_date > arrival_date),
  CHECK (rooms_count   >= 1)
);
CREATE UNIQUE INDEX ux_reservations_number ON reservations(property_id, reservation_number);
CREATE INDEX idx_reservations_tenant_status ON reservations(tenant_id, status);
CREATE INDEX idx_reservations_property_dates ON reservations(property_id, arrival_date, departure_date);
CREATE INDEX idx_reservations_holder ON reservations(holder_guest_id);
CREATE INDEX idx_reservations_room_type ON reservations(room_type_id);

ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations FORCE  ROW LEVEL SECURITY;
CREATE POLICY reservations_by_app ON reservations
  USING (tenant_id::text = current_setting('app.tenant_id', true));
