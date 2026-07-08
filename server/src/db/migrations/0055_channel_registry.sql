-- Phase 49: Channel registry.
-- Per-tenant/property record of every supported OTA channel with status,
-- enable/disable kill switch, and last sync/error state.
-- Status is never auto-promoted to 'live' by the system; an admin must
-- explicitly call PATCH /api/channel/registry/:channel/status.

CREATE TABLE IF NOT EXISTS channel_registry (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID         NOT NULL REFERENCES tenants(id),
  property_id    UUID         REFERENCES properties(id) ON DELETE CASCADE,
  channel_code   TEXT         NOT NULL,
  display_name   TEXT         NOT NULL,
  enabled        BOOLEAN      NOT NULL DEFAULT false,
  status         TEXT         NOT NULL DEFAULT 'not_configured'
                              CHECK (status IN
                                ('not_configured','configured','sandbox','live','error','paused')),
  commission_pct NUMERIC(5,2),
  last_sync_at   TIMESTAMPTZ,
  last_error     TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, property_id, channel_code)
);

ALTER TABLE channel_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_registry FORCE  ROW LEVEL SECURITY;

CREATE POLICY channel_registry_tenant_isolation ON channel_registry
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE INDEX IF NOT EXISTS channel_registry_tenant_idx   ON channel_registry (tenant_id);
CREATE INDEX IF NOT EXISTS channel_registry_property_idx ON channel_registry (property_id)
  WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS channel_registry_code_idx     ON channel_registry (channel_code);
CREATE INDEX IF NOT EXISTS channel_registry_status_idx   ON channel_registry (status);
