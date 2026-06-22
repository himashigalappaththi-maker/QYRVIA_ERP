-- QYRVIA Architecture Hardening (Phase 5.5) - Channel Manager, Revenue
-- Management, Reputation foundations.
--
-- WHY: Each of these modules attaches to the existing Connector framework
--      (Phase 3) and the PMS aggregates (Phase 5). The tables below capture
--      the persistence shape so no future module needs to redesign joins
--      or sync semantics.

-- ============================================================================
-- Channel Mappings  (PMS local entity <-> remote OTA / channel)
-- ============================================================================
CREATE TYPE channel_mapping_kind AS ENUM (
  'PROPERTY','ROOM_TYPE','RATE_PLAN','RATE_PERIOD','POLICY','MEAL_PLAN','BED_TYPE','OTHER'
);

CREATE TABLE channel_mappings (
  id                UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID                  NOT NULL REFERENCES tenants(id),
  property_id       UUID                  NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  connector_code    VARCHAR(40)           NOT NULL,           -- e.g. 'booking_com','agoda','expedia'
  mapping_kind      channel_mapping_kind  NOT NULL,
  local_id          VARCHAR(64)           NOT NULL,           -- the PMS id
  remote_id         VARCHAR(120)          NOT NULL,           -- OTA's id
  payload           JSONB                 NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ           NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ           NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, connector_code, mapping_kind, local_id, remote_id)
);
CREATE INDEX idx_channel_mappings_lookup ON channel_mappings(property_id, connector_code, mapping_kind);
ALTER TABLE channel_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_mappings FORCE  ROW LEVEL SECURITY;
CREATE POLICY channel_mappings_by_app ON channel_mappings
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TYPE channel_sync_direction AS ENUM ('PULL','PUSH');
CREATE TYPE channel_sync_status    AS ENUM ('PENDING','SUCCESS','FAILED','SKIPPED');

CREATE TABLE channel_inventory_sync_log (
  id              UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID                    NOT NULL REFERENCES tenants(id),
  property_id     UUID                    NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  connector_code  VARCHAR(40)             NOT NULL,
  direction       channel_sync_direction  NOT NULL,
  status          channel_sync_status     NOT NULL DEFAULT 'PENDING',
  date_from       DATE,
  date_to         DATE,
  room_type_id    UUID                    REFERENCES room_types(id) ON DELETE SET NULL,
  rate_plan_id    UUID                    REFERENCES rate_plans(id) ON DELETE SET NULL,
  message         TEXT,
  payload         JSONB                   NOT NULL DEFAULT '{}'::jsonb,
  started_at      TIMESTAMPTZ             NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX idx_chan_sync_property_started ON channel_inventory_sync_log(property_id, started_at DESC);
ALTER TABLE channel_inventory_sync_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_inventory_sync_log FORCE  ROW LEVEL SECURITY;
CREATE POLICY chan_sync_by_app ON channel_inventory_sync_log
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ============================================================================
-- Revenue Management snapshots (occupancy, ADR, RevPAR, forecast)
-- ============================================================================
CREATE TABLE revenue_snapshots (
  id                 UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID            NOT NULL REFERENCES tenants(id),
  property_id        UUID            NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  snapshot_date      DATE            NOT NULL,    -- as-of business date
  for_date           DATE            NOT NULL,    -- the date being measured
  rooms_available    INTEGER         NOT NULL DEFAULT 0,
  rooms_sold         INTEGER         NOT NULL DEFAULT 0,
  occupancy_pct      NUMERIC(5,2)    NOT NULL DEFAULT 0,
  adr                NUMERIC(14,2)   NOT NULL DEFAULT 0,
  revpar             NUMERIC(14,2)   NOT NULL DEFAULT 0,
  forecast_kind      VARCHAR(20),                 -- 'ACTUAL' | 'FORECAST'
  source             VARCHAR(40),                 -- e.g. 'night_audit','ai_revenue'
  payload            JSONB           NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),
  UNIQUE (property_id, snapshot_date, for_date, forecast_kind)
);
CREATE INDEX idx_rev_snapshots_property_date ON revenue_snapshots(property_id, for_date);
ALTER TABLE revenue_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_snapshots FORCE  ROW LEVEL SECURITY;
CREATE POLICY rev_snapshots_by_app ON revenue_snapshots
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ============================================================================
-- Reputation - reviews from OTAs / Google / TripAdvisor
-- ============================================================================
CREATE TABLE reviews (
  id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID            NOT NULL REFERENCES tenants(id),
  property_id       UUID            NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  channel           VARCHAR(40)     NOT NULL,        -- 'google','booking_com','agoda','expedia','tripadvisor','direct'
  channel_review_id VARCHAR(120),
  reservation_id    UUID            REFERENCES reservations(id) ON DELETE SET NULL,
  guest_name        VARCHAR(200),
  rating            NUMERIC(3,1)    NOT NULL,        -- normalised 0.0 - 10.0
  rating_scale_max  NUMERIC(3,1)    NOT NULL DEFAULT 10.0,
  language          VARCHAR(8),
  title             TEXT,
  body              TEXT,
  reply             TEXT,
  reply_at          TIMESTAMPTZ,
  ai_generated_reply BOOLEAN        NOT NULL DEFAULT false,
  sentiment         VARCHAR(20),                     -- 'POSITIVE','NEUTRAL','NEGATIVE'
  posted_at         TIMESTAMPTZ,
  imported_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),
  payload           JSONB           NOT NULL DEFAULT '{}'::jsonb,
  CHECK (rating >= 0)
);
CREATE UNIQUE INDEX ux_reviews_channel_id ON reviews(channel, channel_review_id)
  WHERE channel_review_id IS NOT NULL;
CREATE INDEX idx_reviews_property_posted ON reviews(property_id, posted_at DESC);
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews FORCE  ROW LEVEL SECURITY;
CREATE POLICY reviews_by_app ON reviews
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TABLE reputation_scores (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID            NOT NULL REFERENCES tenants(id),
  property_id     UUID            NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  computed_for    DATE            NOT NULL,
  composite_score NUMERIC(4,2)    NOT NULL,
  channel_scores  JSONB           NOT NULL DEFAULT '{}'::jsonb,
  computed_at     TIMESTAMPTZ     NOT NULL DEFAULT now(),
  UNIQUE (property_id, computed_for)
);
ALTER TABLE reputation_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE reputation_scores FORCE  ROW LEVEL SECURITY;
CREATE POLICY reputation_scores_by_app ON reputation_scores
  USING (tenant_id::text = current_setting('app.tenant_id', true));
