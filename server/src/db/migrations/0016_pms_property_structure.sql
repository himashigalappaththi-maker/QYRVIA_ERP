-- QYRVIA Phase 5 - PMS Property Structure.
-- Building / Floor / RoomType / Room / RoomFeature + Room<->Feature M2M.
-- Property already exists from Phase 1.

CREATE TABLE buildings (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  property_id  UUID         NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  code         VARCHAR(40)  NOT NULL,
  name         VARCHAR(200) NOT NULL,
  active       BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by   UUID
);
CREATE UNIQUE INDEX ux_buildings_code ON buildings(property_id, code);
CREATE INDEX idx_buildings_tenant ON buildings(tenant_id);

CREATE TABLE floors (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  property_id  UUID         NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  building_id  UUID         NOT NULL REFERENCES buildings(id) ON DELETE RESTRICT,
  code         VARCHAR(40)  NOT NULL,
  name         VARCHAR(120) NOT NULL,
  active       BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_floors_code ON floors(building_id, code);
CREATE INDEX idx_floors_tenant ON floors(tenant_id);

CREATE TABLE room_types (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID         NOT NULL REFERENCES tenants(id),
  property_id        UUID         NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  code               VARCHAR(40)  NOT NULL,
  name               VARCHAR(200) NOT NULL,
  description        TEXT,
  max_adults         INTEGER      NOT NULL DEFAULT 2,
  max_children       INTEGER      NOT NULL DEFAULT 0,
  base_occupancy     INTEGER      NOT NULL DEFAULT 2,
  extra_bed_capacity INTEGER      NOT NULL DEFAULT 0,
  active             BOOLEAN      NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by         UUID,
  CHECK (max_adults     >= 1),
  CHECK (max_children   >= 0),
  CHECK (base_occupancy >= 1)
);
CREATE UNIQUE INDEX ux_room_types_code ON room_types(property_id, code);
CREATE INDEX idx_room_types_tenant ON room_types(tenant_id);

CREATE TYPE room_status AS ENUM (
  'VACANT_CLEAN','VACANT_DIRTY','OCCUPIED','OUT_OF_ORDER','OUT_OF_SERVICE','INSPECTED','BLOCKED'
);

CREATE TABLE rooms (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  property_id  UUID         NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  building_id  UUID         REFERENCES buildings(id) ON DELETE RESTRICT,
  floor_id     UUID         REFERENCES floors(id)    ON DELETE RESTRICT,
  room_type_id UUID         NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
  room_number  VARCHAR(40)  NOT NULL,
  room_name    VARCHAR(200),
  status       room_status  NOT NULL DEFAULT 'VACANT_CLEAN',
  active       BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by   UUID
);
CREATE UNIQUE INDEX ux_rooms_number ON rooms(property_id, room_number);
CREATE INDEX idx_rooms_type   ON rooms(room_type_id);
CREATE INDEX idx_rooms_tenant ON rooms(tenant_id);

CREATE TABLE room_features (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  property_id  UUID         NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  code         VARCHAR(40)  NOT NULL,
  name         VARCHAR(200) NOT NULL,
  active       BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_room_features_code ON room_features(property_id, code);

CREATE TABLE room_room_features (
  room_id      UUID         NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  feature_id   UUID         NOT NULL REFERENCES room_features(id) ON DELETE CASCADE,
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  PRIMARY KEY (room_id, feature_id)
);
CREATE INDEX idx_room_room_features_tenant ON room_room_features(tenant_id);

-- RLS
ALTER TABLE buildings          ENABLE ROW LEVEL SECURITY; ALTER TABLE buildings          FORCE ROW LEVEL SECURITY;
ALTER TABLE floors             ENABLE ROW LEVEL SECURITY; ALTER TABLE floors             FORCE ROW LEVEL SECURITY;
ALTER TABLE room_types         ENABLE ROW LEVEL SECURITY; ALTER TABLE room_types         FORCE ROW LEVEL SECURITY;
ALTER TABLE rooms              ENABLE ROW LEVEL SECURITY; ALTER TABLE rooms              FORCE ROW LEVEL SECURITY;
ALTER TABLE room_features      ENABLE ROW LEVEL SECURITY; ALTER TABLE room_features      FORCE ROW LEVEL SECURITY;
ALTER TABLE room_room_features ENABLE ROW LEVEL SECURITY; ALTER TABLE room_room_features FORCE ROW LEVEL SECURITY;
CREATE POLICY buildings_by_app          ON buildings          USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY floors_by_app             ON floors             USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY room_types_by_app         ON room_types         USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY rooms_by_app              ON rooms              USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY room_features_by_app      ON room_features      USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY room_room_features_by_app ON room_room_features USING (tenant_id::text = current_setting('app.tenant_id', true));
