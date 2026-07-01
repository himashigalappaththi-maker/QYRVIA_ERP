-- QYRVIA Phase 24 (B8-B2) - mapping versioning + append-only history. DEFINITION
-- ONLY: additive columns on channel_mapping_store + a new history table. Internal
-- data only; no OTA connectivity. Lets a booking be reconciled against the mapping
-- that was live at ingest time (disputes / late webhooks).

ALTER TABLE channel_mapping_store
  ADD COLUMN mapping_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN ota_property_id VARCHAR(120);

CREATE TABLE channel_mapping_history (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID         NOT NULL REFERENCES tenants(id),
  property_id       UUID         REFERENCES properties(id),
  channel           VARCHAR(60),
  room_type_id      UUID,
  ota_room_id       VARCHAR(120),
  ota_rate_plan_id  VARCHAR(120),
  ota_property_id   VARCHAR(120),
  enabled           BOOLEAN,
  mapping_version   INTEGER      NOT NULL,
  change_type       VARCHAR(20)  NOT NULL
                      CHECK (change_type IN ('CREATED','UPDATED','DISABLED','ENABLED')),
  actor_id          UUID,
  changed_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_cmh_scope   ON channel_mapping_history(tenant_id, property_id, channel, room_type_id);
CREATE INDEX idx_cmh_version ON channel_mapping_history(tenant_id, channel, room_type_id, mapping_version);

ALTER TABLE channel_mapping_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_mapping_history FORCE  ROW LEVEL SECURITY;
CREATE POLICY channel_mapping_history_by_app ON channel_mapping_history
  USING (tenant_id::text = current_setting('app.tenant_id', true));
