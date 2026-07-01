-- QYRVIA Phase 24 (S4 / B2) - Channel Manager persistence foundation.
--
-- Five durable stores backing the in-memory channelMappingStore / channelSyncQueue
-- and the (future) dead-letter + sync-state tracking. DEFINITION ONLY: nothing in
-- the runtime selects these until CHANNEL_PERSISTENCE=db|dual (default 'memory').
--
-- Conventions mirror event_store / reservations: UUID PKs, tenant_id/property_id
-- FKs, per-table RLS (app.tenant_id), created_at/updated_at audit fields, JSONB
-- for opaque payloads. Idempotency anchors are real UNIQUE constraints.

-- ===========================================================================
-- 1) channel_booking_store - durable canonical booking mirror (inbound)
-- ===========================================================================
CREATE TABLE channel_booking_store (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES tenants(id),
  property_id         UUID         REFERENCES properties(id),
  channel             VARCHAR(60)  NOT NULL,
  external_ref        VARCHAR(120) NOT NULL,
  status              VARCHAR(40),
  guest_name          VARCHAR(200),
  arrival             DATE,
  departure           DATE,
  room_type_id        UUID,
  amount              NUMERIC(14,2),
  currency            VARCHAR(8),
  pms_reservation_id  UUID         REFERENCES reservations(id),
  source_channel      VARCHAR(60),
  version             INTEGER      NOT NULL DEFAULT 1,
  payload_json        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_channel_booking_natural UNIQUE (tenant_id, channel, external_ref)
);
CREATE INDEX idx_cbs_tenant_status     ON channel_booking_store(tenant_id, status);
CREATE INDEX idx_cbs_pms_reservation   ON channel_booking_store(pms_reservation_id);
CREATE INDEX idx_cbs_slot              ON channel_booking_store(tenant_id, property_id, arrival, departure);
ALTER TABLE channel_booking_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_booking_store FORCE  ROW LEVEL SECURITY;
CREATE POLICY channel_booking_store_by_app ON channel_booking_store
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ===========================================================================
-- 2) channel_mapping_store - room/rate mapping + reservation->channel links
-- ===========================================================================
CREATE TABLE channel_mapping_store (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID         NOT NULL REFERENCES tenants(id),
  property_id       UUID         REFERENCES properties(id),
  channel           VARCHAR(60)  NOT NULL,
  enabled           BOOLEAN      NOT NULL DEFAULT TRUE,
  credentials_ref   VARCHAR(200),                       -- opaque reference, NEVER a secret
  room_type_id      UUID,
  ota_room_id       VARCHAR(120),
  ota_rate_plan_id  VARCHAR(120),
  reservation_id    UUID,
  external_id       VARCHAR(120),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- room/rate mapping rows (room_type present)
CREATE UNIQUE INDEX uq_cms_mapping ON channel_mapping_store(tenant_id, property_id, channel, room_type_id)
  WHERE room_type_id IS NOT NULL;
-- reservation-link rows (reservation present)
CREATE UNIQUE INDEX uq_cms_reservation_link ON channel_mapping_store(tenant_id, reservation_id, channel)
  WHERE reservation_id IS NOT NULL;
CREATE INDEX idx_cms_tenant_channel ON channel_mapping_store(tenant_id, property_id, channel);
ALTER TABLE channel_mapping_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_mapping_store FORCE  ROW LEVEL SECURITY;
CREATE POLICY channel_mapping_store_by_app ON channel_mapping_store
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ===========================================================================
-- 3) channel_sync_queue_store - durable outbound job queue
-- ===========================================================================
CREATE TABLE channel_sync_queue_store (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  property_id     UUID         REFERENCES properties(id),
  reservation_id  VARCHAR(64)  NOT NULL,
  action          VARCHAR(40)  NOT NULL
                    CHECK (action IN ('CREATE_BOOKING','UPDATE_BOOKING','CANCEL_BOOKING','CHECK_IN','CHECK_OUT')),
  channel         VARCHAR(60),
  payload_json    JSONB        NOT NULL DEFAULT '{}'::jsonb,
  status          VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),
  attempts        INTEGER      NOT NULL DEFAULT 0,
  lease_until     TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- Dedupe: only ONE PENDING (reservation_id + action) at a time (matches S3 pendingKeys).
CREATE UNIQUE INDEX uq_csqs_pending ON channel_sync_queue_store(tenant_id, reservation_id, action)
  WHERE status = 'PENDING';
CREATE INDEX idx_csqs_poll ON channel_sync_queue_store(status, next_run_at);
ALTER TABLE channel_sync_queue_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_sync_queue_store FORCE  ROW LEVEL SECURITY;
CREATE POLICY channel_sync_queue_store_by_app ON channel_sync_queue_store
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ===========================================================================
-- 4) channel_dead_letter_store - terminal failures + reprocess control
-- ===========================================================================
CREATE TABLE channel_dead_letter_store (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES tenants(id),
  property_id         UUID         REFERENCES properties(id),
  reservation_id      VARCHAR(64)  NOT NULL,
  action              VARCHAR(40)  NOT NULL,
  channel             VARCHAR(60),
  payload_json        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  attempts            INTEGER      NOT NULL DEFAULT 1,
  last_error          TEXT,
  dedupe_generation   INTEGER      NOT NULL DEFAULT 0,
  reprocess_requested BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_cdls_coalesce UNIQUE (tenant_id, reservation_id, action, dedupe_generation)
);
CREATE INDEX idx_cdls_reprocess ON channel_dead_letter_store(tenant_id, reprocess_requested);
ALTER TABLE channel_dead_letter_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_dead_letter_store FORCE  ROW LEVEL SECURITY;
CREATE POLICY channel_dead_letter_store_by_app ON channel_dead_letter_store
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ===========================================================================
-- 5) channel_sync_state_store - per-resource delta hash + last sync status
-- ===========================================================================
CREATE TABLE channel_sync_state_store (
  tenant_id      UUID         NOT NULL REFERENCES tenants(id),
  property_id    UUID         REFERENCES properties(id),
  channel        VARCHAR(60)  NOT NULL,
  resource_key   VARCHAR(200) NOT NULL,
  reservation_id VARCHAR(64),
  last_hash      VARCHAR(200),
  last_status    VARCHAR(40),
  last_error     TEXT,
  last_sync_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel, resource_key)
);
CREATE INDEX idx_csss_tenant_channel ON channel_sync_state_store(tenant_id, channel);
CREATE INDEX idx_csss_reservation    ON channel_sync_state_store(reservation_id);
ALTER TABLE channel_sync_state_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_sync_state_store FORCE  ROW LEVEL SECURITY;
CREATE POLICY channel_sync_state_store_by_app ON channel_sync_state_store
  USING (tenant_id::text = current_setting('app.tenant_id', true));
