-- QYRVIA Architecture Hardening (Phase 5.5) - Multi-Property + Reservation
-- status enum extension.
--
-- WHY this migration exists:
--   The Architecture Readiness Review identified missing fields that every
--   future module assumes: brand identity (company_name + logos), property
--   contact metadata (address/phone/email/timezone), and the operational
--   reservation states CHECKED_IN / CHECKED_OUT / DEPARTED which underpin
--   Check-In, Folio, Night-Audit, and Mobile-Check-In modules. Without
--   these now, every future module would force a backfill migration on
--   every existing reservation row.

-- ---- tenants (acts as the company / corporate group) ---------------------
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_name   VARCHAR(200);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_logo_url TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS legal_name     VARCHAR(200);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tax_id         VARCHAR(80);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_email  VARCHAR(200);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS country_code   CHAR(2);

-- ---- properties (per-hotel brand + contact + ops metadata) ---------------
ALTER TABLE properties ADD COLUMN IF NOT EXISTS logo_url      TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS address       TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS phone         VARCHAR(40);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS email         VARCHAR(200);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS timezone      VARCHAR(64);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS country_code  CHAR(2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS license_no    VARCHAR(80);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS star_rating   SMALLINT
  CHECK (star_rating IS NULL OR (star_rating BETWEEN 1 AND 7));
ALTER TABLE properties ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT now();

-- ---- reservation_status enum extension -----------------------------------
-- ENUM ALTERs must run outside a transaction; the migration runner already
-- wraps each file in its own connection, and PostgreSQL 12+ permits
-- ADD VALUE IF NOT EXISTS without serialization issues.
ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'CHECKED_IN';
ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'CHECKED_OUT';
ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'DEPARTED';
ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'WAITLIST';

-- ---- reservations: operational stamps used by downstream modules ---------
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS checked_in_at      TIMESTAMPTZ;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS checked_in_by      UUID;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS checked_out_at     TIMESTAMPTZ;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS checked_out_by     UUID;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS assigned_room_id   UUID REFERENCES rooms(id) ON DELETE SET NULL;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS source_channel     VARCHAR(40);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS external_ref       VARCHAR(120);

CREATE INDEX IF NOT EXISTS idx_reservations_assigned_room
  ON reservations(assigned_room_id) WHERE assigned_room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservations_external_ref
  ON reservations(external_ref) WHERE external_ref IS NOT NULL;
