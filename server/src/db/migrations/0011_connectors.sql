-- QYRVIA Phase 3 - connector registry.
-- connectors: catalog of supported integration types (global).
-- connector_configs: per-tenant per-connector configuration record (credentials
--                    actually live on backend .env or a secrets vault; this
--                    table only stores presence flags + non-secret config).
-- connector_health_log: probe + healthCheck history.

CREATE TYPE connector_type AS ENUM (
  'payment_gateway',
  'channel_manager',
  'email_provider',
  'sms_provider',
  'whatsapp_provider',
  'ai_provider',
  'biometric_provider',
  'door_lock_provider'
);

CREATE TABLE connectors (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  code        VARCHAR(80)  UNIQUE NOT NULL,         -- e.g. 'stripe', 'booking_com', 'zk_teco'
  label       VARCHAR(200) NOT NULL,
  type        connector_type NOT NULL,
  description TEXT,
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE connector_configs (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id),
  property_id   UUID         REFERENCES properties(id),
  connector_id  UUID         NOT NULL REFERENCES connectors(id),
  enabled       BOOLEAN      NOT NULL DEFAULT false,
  config_json   JSONB        NOT NULL DEFAULT '{}'::jsonb,    -- non-secret config; secret refs go in vault
  configured_by UUID,
  configured_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- Expression-based unique index (PG forbids expressions inside UNIQUE constraints)
CREATE UNIQUE INDEX ux_connector_configs_unique ON connector_configs
  (tenant_id, COALESCE(property_id, '00000000-0000-0000-0000-000000000000'::uuid), connector_id);
CREATE INDEX idx_connector_configs_lookup ON connector_configs(tenant_id, connector_id);

CREATE TYPE connector_health_status AS ENUM ('configured','not_configured','healthy','unhealthy','unreachable','unknown');

CREATE TABLE connector_health_log (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  connector_id UUID         NOT NULL REFERENCES connectors(id),
  kind         VARCHAR(20)  NOT NULL CHECK (kind IN ('probe','health')),
  status       connector_health_status NOT NULL,
  detail       TEXT,
  latency_ms   INTEGER,
  occurred_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_connector_health_lookup ON connector_health_log(tenant_id, connector_id, occurred_at DESC);

ALTER TABLE connector_configs    ENABLE ROW LEVEL SECURITY; ALTER TABLE connector_configs    FORCE ROW LEVEL SECURITY;
ALTER TABLE connector_health_log ENABLE ROW LEVEL SECURITY; ALTER TABLE connector_health_log FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_configs_by_app    ON connector_configs    USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY connector_health_log_by_app ON connector_health_log USING (tenant_id::text = current_setting('app.tenant_id', true));
-- connectors table is global; no RLS

-- Seed the known connector types so the registry exists from day one
INSERT INTO connectors (code, label, type) VALUES
  ('stripe',         'Stripe',             'payment_gateway'),
  ('razorpay',       'Razorpay',           'payment_gateway'),
  ('payhere',        'PayHere',            'payment_gateway'),
  ('booking_com',    'Booking.com',        'channel_manager'),
  ('expedia',        'Expedia',            'channel_manager'),
  ('agoda',          'Agoda',              'channel_manager'),
  ('smtp',           'SMTP Email',         'email_provider'),
  ('twilio_sms',     'Twilio SMS',         'sms_provider'),
  ('whatsapp_cloud', 'WhatsApp Cloud API', 'whatsapp_provider'),
  ('anthropic',      'Anthropic Claude',   'ai_provider'),
  ('openai',         'OpenAI',             'ai_provider'),
  ('gemini',         'Google Gemini',      'ai_provider'),
  ('zk_teco',        'ZKTeco',             'biometric_provider'),
  ('hikvision',      'Hikvision',          'biometric_provider'),
  ('suprema',        'Suprema',            'biometric_provider'),
  ('assa_abloy',     'ASSA ABLOY',         'door_lock_provider'),
  ('saflok',         'Dormakaba Saflok',   'door_lock_provider');
