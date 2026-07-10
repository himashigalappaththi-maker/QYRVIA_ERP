-- QYRVIA Phase 53 - Channel Manager Hardening: inbound OTA booking import audit log.
--
-- Every inbound OTA booking attempt is appended here BEFORE the channel_booking_store
-- upsert so that idempotency detection and full import audit are available even when
-- the upsert is skipped (deduped) or fails (error).
--
-- Design decisions:
--   - Append-only: no UPDATE policy, no DELETE policy.
--   - outcome CHECK constraint is the authoritative status vocabulary.
--   - idempotency_key partial-unique index prevents duplicate import log entries
--     for the same logical delivery (WHERE idempotency_key IS NOT NULL).
--   - RLS uses app_current_tenant() (SARGable, consistent with 0051 pattern).
--   - FORCE ROW LEVEL SECURITY ensures the table owner is also filtered.

BEGIN;

CREATE TABLE IF NOT EXISTS channel_booking_import_log (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  property_id         UUID         REFERENCES properties(id) ON DELETE SET NULL,
  channel_code        VARCHAR(40)  NOT NULL,
  external_booking_id VARCHAR(255),
  idempotency_key     VARCHAR(512),
  payload_hash        VARCHAR(64),          -- SHA-256 hex of raw inbound payload
  outcome             VARCHAR(20)  NOT NULL
                        CHECK (outcome IN ('accepted','deduped','rejected','error')),
  error_message       TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Composite covering index: tenant + channel + recency (supports audit queries)
CREATE INDEX IF NOT EXISTS ix_cbil_tenant_channel
  ON channel_booking_import_log(tenant_id, channel_code, created_at DESC);

-- Idempotency guard: one log row per (tenant, idempotency_key) for keyed deliveries
CREATE UNIQUE INDEX IF NOT EXISTS uq_cbil_idempotency
  ON channel_booking_import_log(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE channel_booking_import_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_booking_import_log FORCE  ROW LEVEL SECURITY;

-- SARGable isolation policy (0051 pattern): SELECT scoped + INSERT constrained
CREATE POLICY channel_booking_import_log_tenant_isolation
  ON channel_booking_import_log
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

COMMIT;
