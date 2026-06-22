-- QYRVIA Phase 5 - Guest Management Foundation.
-- A guest is a person/entity that CAN be a reservation holder.
-- Child policy enforces "a child is NEVER a reservation holder" at the
-- domain layer (reservation.create command refuses non-Adult holders).

CREATE TYPE guest_type AS ENUM (
  'INDIVIDUAL', 'CORPORATE', 'TRAVEL_AGENT', 'DMC', 'TOUR_ORGANIZER'
);

CREATE TABLE guests (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  property_id     UUID         REFERENCES properties(id),       -- nullable: tenant-wide guests allowed
  guest_type      guest_type   NOT NULL DEFAULT 'INDIVIDUAL',
  -- Person fields (used for INDIVIDUAL; optional contact for others)
  title           VARCHAR(20),
  first_name      VARCHAR(120) NOT NULL,
  last_name       VARCHAR(120),
  gender          VARCHAR(20),
  dob             DATE,
  nationality     VARCHAR(80),
  language        VARCHAR(16),
  email           VARCHAR(200),
  mobile          VARCHAR(40),
  address         TEXT,
  passport_number VARCHAR(60),
  national_id     VARCHAR(60),
  -- Corporate/Agent/DMC/Tour fields
  organization_name VARCHAR(200),
  tax_id            VARCHAR(60),
  -- Flags
  vip_flag         BOOLEAN     NOT NULL DEFAULT false,
  blacklisted_flag BOOLEAN     NOT NULL DEFAULT false,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       UUID
);
CREATE INDEX idx_guests_tenant_type        ON guests(tenant_id, guest_type);
CREATE INDEX idx_guests_email              ON guests(tenant_id, email)         WHERE email     IS NOT NULL;
CREATE INDEX idx_guests_mobile             ON guests(tenant_id, mobile)        WHERE mobile    IS NOT NULL;
CREATE INDEX idx_guests_passport           ON guests(tenant_id, passport_number) WHERE passport_number IS NOT NULL;
CREATE INDEX idx_guests_org                ON guests(tenant_id, organization_name) WHERE organization_name IS NOT NULL;
CREATE INDEX idx_guests_blacklist          ON guests(tenant_id) WHERE blacklisted_flag = true;

ALTER TABLE guests ENABLE ROW LEVEL SECURITY;
ALTER TABLE guests FORCE  ROW LEVEL SECURITY;
CREATE POLICY guests_by_app ON guests
  USING (tenant_id::text = current_setting('app.tenant_id', true));
