-- Phase 46B: Gate passes table.
-- The gatepass.read / gatepass.write permissions were pre-seeded in 0030.
-- This migration creates the backing table and RLS policy.

CREATE TABLE IF NOT EXISTS gate_passes (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES tenants(id),
  property_id         UUID        REFERENCES properties(id) ON DELETE SET NULL,
  pass_no             TEXT        NOT NULL,
  type                TEXT        NOT NULL CHECK (type IN ('GUEST','VISITOR','STAFF','VENDOR','CONTRACTOR')),
  name                TEXT        NOT NULL,
  movement            TEXT        NOT NULL DEFAULT 'IN/OUT' CHECK (movement IN ('IN','OUT','IN/OUT')),
  reservation_id      TEXT,
  created_by_user_id  UUID        NOT NULL,
  purpose             TEXT,
  status              TEXT        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','USED','EXPIRED','CANCELLED')),
  valid_from          TIMESTAMPTZ NOT NULL DEFAULT now(),
  scans               JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE gate_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE gate_passes FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gate_passes_tenant_isolation ON gate_passes;
CREATE POLICY gate_passes_tenant_isolation ON gate_passes
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS gate_passes_tenant_idx     ON gate_passes (tenant_id);
CREATE INDEX IF NOT EXISTS gate_passes_created_by_idx ON gate_passes (created_by_user_id);
CREATE INDEX IF NOT EXISTS gate_passes_property_idx   ON gate_passes (property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gate_passes_status_idx     ON gate_passes (status);
