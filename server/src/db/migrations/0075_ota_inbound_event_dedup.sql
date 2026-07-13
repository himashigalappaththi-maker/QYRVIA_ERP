-- Phase 58 — Persistent OTA inbound event deduplication
-- 0075_ota_inbound_event_dedup.sql
--
-- Uniqueness scope: (tenant_id, property_id, channel_code, event_type, dedup_key).
-- property_id is nullable; NULL values collapse via COALESCE to a sentinel UUID so
-- that two NULL-property rows with the same channel/event/key are treated as
-- duplicates — the desired behaviour for tenant-wide, property-agnostic OTA events.
--
-- Service upserts MUST reference the same expression in their ON CONFLICT target:
--
--   ON CONFLICT (
--     tenant_id,
--     COALESCE(property_id, '00000000-0000-0000-0000-000000000000'::uuid),
--     channel_code,
--     event_type,
--     dedup_key
--   )
--
-- ON CONFLICT ON CONSTRAINT cannot be used here because uq_ota_inbound_event_dedup
-- is an expression index, not a named table constraint.
--
-- RLS: app_current_tenant() established in migration 0051.

BEGIN;

CREATE TABLE IF NOT EXISTS ota_inbound_event_dedup (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID         NOT NULL REFERENCES tenants(id),
  property_id       UUID         REFERENCES properties(id),
  channel_code      VARCHAR(60)  NOT NULL CHECK (btrim(channel_code) <> ''),
  event_type        VARCHAR(60)  NOT NULL CHECK (btrim(event_type)   <> ''),
  dedup_key         VARCHAR(512) NOT NULL CHECK (btrim(dedup_key)    <> ''),
  processing_status VARCHAR(20)  NOT NULL DEFAULT 'received'
                    CHECK (processing_status IN ('received','processed','duplicate','rejected')),
  first_received_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_received_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  delivery_count    INTEGER      NOT NULL DEFAULT 1 CHECK (delivery_count >= 1),
  processed_at      TIMESTAMPTZ,
  result_ref        VARCHAR(200),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Null-safe expression unique index — full deduplication scope.
-- Sentinel '00000000-0000-0000-0000-000000000000' represents "no specific property".
-- This is NOT a named table constraint; ON CONFLICT must reference the exact expression.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ota_inbound_event_dedup
  ON ota_inbound_event_dedup (
    tenant_id,
    COALESCE(property_id, '00000000-0000-0000-0000-000000000000'::uuid),
    channel_code,
    event_type,
    dedup_key
  );

-- Supporting index for property-scoped monitoring and OTA dashboard queries
CREATE INDEX IF NOT EXISTS idx_ota_dedup_property
  ON ota_inbound_event_dedup (tenant_id, property_id)
  WHERE property_id IS NOT NULL;

ALTER TABLE ota_inbound_event_dedup ENABLE ROW LEVEL SECURITY;
ALTER TABLE ota_inbound_event_dedup FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ota_inbound_event_dedup_tenant_isolation ON ota_inbound_event_dedup;
CREATE POLICY ota_inbound_event_dedup_tenant_isolation
  ON ota_inbound_event_dedup
  USING     (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

COMMIT;
