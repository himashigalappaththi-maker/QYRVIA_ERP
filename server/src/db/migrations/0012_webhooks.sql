-- QYRVIA Phase 3 - webhook framework.

CREATE TYPE webhook_delivery_status AS ENUM ('pending','sending','delivered','failed','cancelled');

CREATE TABLE webhook_endpoints (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  property_id  UUID         REFERENCES properties(id),
  name         VARCHAR(120) NOT NULL,
  url          VARCHAR(500) NOT NULL,
  secret       VARCHAR(120) NOT NULL,                    -- HMAC-SHA256 signing key (stored hashed in a later phase)
  event_types  TEXT[]       NOT NULL DEFAULT '{}',       -- subscribe to specific event types (empty = all)
  is_active    BOOLEAN      NOT NULL DEFAULT true,
  created_by   UUID,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  disabled_at  TIMESTAMPTZ
);
CREATE INDEX idx_webhook_endpoints_tenant ON webhook_endpoints(tenant_id);

CREATE TABLE webhook_deliveries (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  endpoint_id     UUID         NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id        UUID         REFERENCES event_store(id),
  event_type      VARCHAR(120) NOT NULL,
  payload         JSONB        NOT NULL,
  signature       VARCHAR(120) NOT NULL,                    -- HMAC-SHA256 hex
  status          webhook_delivery_status NOT NULL DEFAULT 'pending',
  attempts        INTEGER      NOT NULL DEFAULT 0,
  max_attempts    INTEGER      NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_status_code INTEGER,
  last_error      TEXT,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhook_deliveries_due      ON webhook_deliveries(status, next_attempt_at) WHERE status IN ('pending','failed');
CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);

ALTER TABLE webhook_endpoints  ENABLE ROW LEVEL SECURITY; ALTER TABLE webhook_endpoints  FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY; ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_endpoints_by_app  ON webhook_endpoints  USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY webhook_deliveries_by_app ON webhook_deliveries USING (tenant_id::text = current_setting('app.tenant_id', true));
