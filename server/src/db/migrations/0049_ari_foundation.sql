-- QYRVIA Phase 30.1 - ARI Foundation (Availability / Rates / Restrictions).
--
-- Standalone internal engine tables: the deterministic source of truth for ARI
-- computation, decoupled from the channel adapters + canonical registry. Conventions
-- mirror the rest of the schema: tenant_id/property_id FKs, per-table FORCE RLS on
-- app.tenant_id, a `version` column for optimistic-concurrency updates. Additive only.

-- 1) room types -------------------------------------------------------------
CREATE TABLE ari_room_type (
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  property_id  UUID         NOT NULL REFERENCES properties(id),
  room_type_id VARCHAR(64)  NOT NULL,
  code         VARCHAR(40)  NOT NULL,
  name         VARCHAR(200),
  total_units  INTEGER      NOT NULL DEFAULT 0 CHECK (total_units >= 0),
  version      INTEGER      NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, property_id, room_type_id)
);

-- 2) rate plans (occupancy + derived structure as JSONB) --------------------
CREATE TABLE ari_rate_plan (
  tenant_id          UUID          NOT NULL REFERENCES tenants(id),
  property_id        UUID          NOT NULL REFERENCES properties(id),
  rate_plan_id       VARCHAR(64)   NOT NULL,
  room_type_id       VARCHAR(64)   NOT NULL,
  code               VARCHAR(40)   NOT NULL,
  name               VARCHAR(200),
  currency           CHAR(3)       NOT NULL DEFAULT 'LKR',
  base_rate          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (base_rate >= 0),
  standard_occupancy INTEGER       NOT NULL DEFAULT 2 CHECK (standard_occupancy >= 0),
  max_occupancy      INTEGER       NOT NULL DEFAULT 2 CHECK (max_occupancy >= standard_occupancy),
  extra_adult_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (extra_adult_amount >= 0),
  occupancy_rates    JSONB         NOT NULL DEFAULT '{}'::jsonb,
  child_rates        JSONB         NOT NULL DEFAULT '[]'::jsonb,
  version            INTEGER       NOT NULL DEFAULT 1,
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, property_id, rate_plan_id)
);

-- 3) date-based inventory grid ---------------------------------------------
CREATE TABLE ari_inventory_grid (
  tenant_id          UUID        NOT NULL REFERENCES tenants(id),
  property_id        UUID        NOT NULL REFERENCES properties(id),
  room_type_id       VARCHAR(64) NOT NULL,
  date               DATE        NOT NULL,
  physical           INTEGER     NOT NULL DEFAULT 0 CHECK (physical >= 0),
  sold               INTEGER     NOT NULL DEFAULT 0 CHECK (sold >= 0),
  blocked            INTEGER     NOT NULL DEFAULT 0 CHECK (blocked >= 0),
  overbooking_buffer INTEGER     NOT NULL DEFAULT 0 CHECK (overbooking_buffer >= 0),
  stop_sell          BOOLEAN     NOT NULL DEFAULT false,
  version            INTEGER     NOT NULL DEFAULT 1,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, property_id, room_type_id, date)
);

-- 4) rate rules (seasonal / dow / override) --------------------------------
CREATE TABLE ari_rate_rule (
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  id           VARCHAR(80)  NOT NULL,
  property_id  UUID         NOT NULL REFERENCES properties(id),
  level        VARCHAR(16)  NOT NULL CHECK (level IN ('system','property','rate_plan','channel')),
  room_type_id VARCHAR(64),
  rate_plan_id VARCHAR(64),
  channel      VARCHAR(60),
  date_from    DATE         NOT NULL,
  date_to      DATE         NOT NULL CHECK (date_to > date_from),
  dow          SMALLINT[],
  kind         VARCHAR(16)  NOT NULL DEFAULT 'override',
  amount       NUMERIC(12,2),
  pct          NUMERIC(6,2),
  priority     INTEGER      NOT NULL DEFAULT 0,
  version      INTEGER      NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_ari_rate_rule_scope ON ari_rate_rule(tenant_id, property_id, date_from, date_to);

-- 5) restriction rules (CTA/CTD/MinLOS/MaxLOS/stay-through/advance window) --
CREATE TABLE ari_restriction_rule (
  tenant_id        UUID         NOT NULL REFERENCES tenants(id),
  id               VARCHAR(80)  NOT NULL,
  property_id      UUID         NOT NULL REFERENCES properties(id),
  level            VARCHAR(16)  NOT NULL CHECK (level IN ('system','property','rate_plan','channel')),
  room_type_id     VARCHAR(64),
  rate_plan_id     VARCHAR(64),
  channel          VARCHAR(60),
  date_from        DATE         NOT NULL,
  date_to          DATE         NOT NULL CHECK (date_to > date_from),
  dow              SMALLINT[],
  cta              BOOLEAN,
  ctd              BOOLEAN,
  min_los          INTEGER,
  max_los          INTEGER,
  stay_through     BOOLEAN,
  min_advance_days INTEGER,
  max_advance_days INTEGER,
  priority         INTEGER      NOT NULL DEFAULT 0,
  version          INTEGER      NOT NULL DEFAULT 1,
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_ari_restriction_rule_scope ON ari_restriction_rule(tenant_id, property_id, date_from, date_to);

-- 6) length-of-stay pricing -------------------------------------------------
CREATE TABLE ari_los_pricing (
  tenant_id    UUID          NOT NULL REFERENCES tenants(id),
  property_id  UUID          NOT NULL REFERENCES properties(id),
  rate_plan_id VARCHAR(64)   NOT NULL,
  los          INTEGER       NOT NULL CHECK (los >= 1),
  amount       NUMERIC(12,2),
  pct          NUMERIC(6,2),
  PRIMARY KEY (tenant_id, property_id, rate_plan_id, los)
);

-- 7) internal channel mapping (RoomType <-> RatePlan <-> Channel) ----------
CREATE TABLE ari_channel_mapping (
  tenant_id        UUID         NOT NULL REFERENCES tenants(id),
  property_id      UUID         NOT NULL REFERENCES properties(id),
  channel          VARCHAR(60)  NOT NULL,
  room_type_id     VARCHAR(64)  NOT NULL,
  rate_plan_id     VARCHAR(64)  NOT NULL,
  ota_room_id      VARCHAR(120),
  ota_rate_plan_id VARCHAR(120),
  enabled          BOOLEAN      NOT NULL DEFAULT true,
  version          INTEGER      NOT NULL DEFAULT 1,
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, property_id, channel, room_type_id, rate_plan_id)
);

-- RLS: tenant isolation on every ARI table (FORCE => binds the owner too) ----
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
      'ari_room_type','ari_rate_plan','ari_inventory_grid','ari_rate_rule',
      'ari_restriction_rule','ari_los_pricing','ari_channel_mapping'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id::text = current_setting(''app.tenant_id'', true))', t || '_by_app', t);
  END LOOP;
END $$;
