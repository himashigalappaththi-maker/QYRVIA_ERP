-- QYRVIA Architecture Hardening (Phase 5.5) - Guest Experience + Mobile
-- Access Control foundations.
--
-- WHY: Guest mobile app, digital reg card, service requests, NFC/BLE/QR
--      keys, and access logs all attach to reservation + room. Reserving
--      the persistence shape here means none of those modules needs to
--      modify reservations or rooms later.

-- ============================================================================
-- Guest service requests (room service, concierge, maintenance, etc.)
-- ============================================================================
CREATE TYPE service_request_category AS ENUM (
  'ROOM_SERVICE','HOUSEKEEPING','MAINTENANCE','CONCIERGE','FRONT_OFFICE',
  'TRANSPORT','SPA','LAUNDRY','WAKE_UP','OTHER'
);

CREATE TYPE service_request_status AS ENUM (
  'NEW','ACKNOWLEDGED','IN_PROGRESS','COMPLETED','CANCELLED','ESCALATED'
);

CREATE TABLE guest_service_requests (
  id                UUID                      PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID                      NOT NULL REFERENCES tenants(id),
  property_id       UUID                      NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  reservation_id    UUID                      REFERENCES reservations(id) ON DELETE SET NULL,
  guest_id          UUID                      REFERENCES guests(id) ON DELETE SET NULL,
  room_id           UUID                      REFERENCES rooms(id) ON DELETE SET NULL,
  category          service_request_category  NOT NULL,
  status            service_request_status    NOT NULL DEFAULT 'NEW',
  priority          SMALLINT                  NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  title             VARCHAR(200)              NOT NULL,
  description       TEXT,
  requested_at      TIMESTAMPTZ               NOT NULL DEFAULT now(),
  acknowledged_at   TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  assigned_to       UUID,
  source            VARCHAR(40),                         -- 'mobile_app','front_desk','phone','whatsapp'
  payload           JSONB                     NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_gsr_property_status ON guest_service_requests(property_id, status);
CREATE INDEX idx_gsr_reservation ON guest_service_requests(reservation_id);
ALTER TABLE guest_service_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_service_requests FORCE  ROW LEVEL SECURITY;
CREATE POLICY gsr_by_app ON guest_service_requests
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ============================================================================
-- Digital registration cards
-- ============================================================================
CREATE TABLE digital_registration_cards (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES tenants(id),
  property_id         UUID         NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  reservation_id      UUID         NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  guest_id            UUID         REFERENCES guests(id),
  status              VARCHAR(20)  NOT NULL DEFAULT 'PENDING',  -- PENDING|SIGNED|VOIDED
  signed_at           TIMESTAMPTZ,
  signature_file_id   UUID,                                     -- references files(id) when fileService is wired
  consent_terms       BOOLEAN      NOT NULL DEFAULT false,
  consent_marketing   BOOLEAN      NOT NULL DEFAULT false,
  payload             JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_drc_reservation ON digital_registration_cards(reservation_id);
ALTER TABLE digital_registration_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE digital_registration_cards FORCE  ROW LEVEL SECURITY;
CREATE POLICY drc_by_app ON digital_registration_cards
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ============================================================================
-- Mobile access control: keys + access logs
-- ============================================================================
CREATE TYPE access_key_kind AS ENUM ('NFC','BLE','QR','PIN','RFID','MAGSTRIPE');

CREATE TYPE access_subject AS ENUM ('GUEST','STAFF','VENDOR','EMERGENCY','MAINTENANCE','HOUSEKEEPING');

CREATE TYPE access_key_status AS ENUM ('ACTIVE','EXPIRED','REVOKED','LOST');

CREATE TABLE access_keys (
  id              UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID              NOT NULL REFERENCES tenants(id),
  property_id     UUID              NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  reservation_id  UUID              REFERENCES reservations(id) ON DELETE SET NULL,
  guest_id        UUID              REFERENCES guests(id) ON DELETE SET NULL,
  user_id         UUID,                                     -- references users(id) when staff
  subject         access_subject    NOT NULL,
  key_kind        access_key_kind   NOT NULL,
  vendor          VARCHAR(40),                              -- 'assa_abloy','salto','dormakaba','onity','custom'
  vendor_key_id   VARCHAR(120),
  granted_room_ids UUID[]           NOT NULL DEFAULT '{}',
  zone_codes      TEXT[]            NOT NULL DEFAULT '{}',  -- 'POOL','GYM','LOUNGE'
  valid_from      TIMESTAMPTZ       NOT NULL,
  valid_to        TIMESTAMPTZ       NOT NULL,
  status          access_key_status NOT NULL DEFAULT 'ACTIVE',
  issued_by       UUID,
  issued_at       TIMESTAMPTZ       NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  revoked_reason  VARCHAR(200),
  payload         JSONB             NOT NULL DEFAULT '{}'::jsonb,
  CHECK (valid_to > valid_from)
);
CREATE INDEX idx_access_keys_property_status ON access_keys(property_id, status);
CREATE INDEX idx_access_keys_reservation ON access_keys(reservation_id);
CREATE INDEX idx_access_keys_vendor ON access_keys(vendor, vendor_key_id);
ALTER TABLE access_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_keys FORCE  ROW LEVEL SECURITY;
CREATE POLICY access_keys_by_app ON access_keys
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TYPE access_action AS ENUM ('UNLOCK','DENIED','ENTRY','EXIT','TAMPER','BATTERY_LOW','ERROR');

CREATE TABLE access_logs (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID            NOT NULL REFERENCES tenants(id),
  property_id     UUID            NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  key_id          UUID            REFERENCES access_keys(id) ON DELETE SET NULL,
  room_id         UUID            REFERENCES rooms(id) ON DELETE SET NULL,
  zone_code       VARCHAR(40),
  action          access_action   NOT NULL,
  occurred_at     TIMESTAMPTZ     NOT NULL DEFAULT now(),
  vendor_event_id VARCHAR(120),
  payload         JSONB           NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_access_logs_property_time ON access_logs(property_id, occurred_at DESC);
CREATE INDEX idx_access_logs_key ON access_logs(key_id);
ALTER TABLE access_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_logs FORCE  ROW LEVEL SECURITY;
CREATE POLICY access_logs_by_app ON access_logs
  USING (tenant_id::text = current_setting('app.tenant_id', true));
