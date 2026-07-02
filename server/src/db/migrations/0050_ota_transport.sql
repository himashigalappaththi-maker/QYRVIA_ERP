-- QYRVIA Phase 30.2 - OTA Transport, Reconciliation & Sync Monitoring persistence.
--
-- Additive only. tenant_id/property_id FKs, FORCE Row-Level Security on app.tenant_id,
-- idempotent sync processing via a partial-unique idempotency key. No changes to any
-- existing table.

-- 1) sync attempts (idempotent outbound delivery tracking) ------------------
CREATE TABLE ota_sync_attempt (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  property_id     UUID         REFERENCES properties(id),
  channel         VARCHAR(60)  NOT NULL,
  op              VARCHAR(40)  NOT NULL,
  status          VARCHAR(12)  NOT NULL CHECK (status IN ('OK','FAILED')),
  attempts        INTEGER      NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  error_code      VARCHAR(80),
  idempotency_key VARCHAR(200),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- idempotent processing: an already-recorded key is a no-op
CREATE UNIQUE INDEX uq_ota_sync_attempt_idem ON ota_sync_attempt(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_ota_sync_attempt_chan ON ota_sync_attempt(tenant_id, channel, created_at);

-- 2) reconciliation drift records ------------------------------------------
CREATE TABLE ota_drift (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID         NOT NULL REFERENCES tenants(id),
  property_id    UUID         REFERENCES properties(id),
  channel        VARCHAR(60)  NOT NULL,
  drift_kind     VARCHAR(16)  NOT NULL CHECK (drift_kind IN ('inventory','rate','reservation')),
  mismatch_type  VARCHAR(20)  NOT NULL CHECK (mismatch_type IN ('missing_remote','missing_local','value_mismatch')),
  resource_key   VARCHAR(200) NOT NULL,
  local_value    JSONB,
  remote_value   JSONB,
  recommendation VARCHAR(60),
  detected_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_ota_drift_chan ON ota_drift(tenant_id, channel, drift_kind, detected_at);

-- 3) transport health (per tenant + channel) -------------------------------
CREATE TABLE ota_transport_health (
  tenant_id            UUID         NOT NULL REFERENCES tenants(id),
  channel              VARCHAR(60)  NOT NULL,
  status               VARCHAR(12)  NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy','degraded','down')),
  consecutive_failures INTEGER      NOT NULL DEFAULT 0,
  last_ok_at           TIMESTAMPTZ,
  last_error           VARCHAR(200),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel)
);

-- RLS: tenant isolation on every OTA table (FORCE => binds the owner too) ----
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['ota_sync_attempt','ota_drift','ota_transport_health']) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id::text = current_setting(''app.tenant_id'', true))', t || '_by_app', t);
  END LOOP;
END $$;
