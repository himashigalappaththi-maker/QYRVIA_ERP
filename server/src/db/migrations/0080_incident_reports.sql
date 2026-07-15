-- Phase 59: Incident reports table.
-- Tenant-owned, property-scoped operational records.
-- RLS uses app_current_tenant() (defined migration 0051).

CREATE TABLE IF NOT EXISTS incident_reports (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID        NOT NULL REFERENCES tenants(id),
  property_id          UUID        NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  incident_number      TEXT        NOT NULL,
  category             TEXT        NOT NULL DEFAULT 'Other'
                                   CHECK (category IN (
                                     'Security','Accident','Fire','Medical',
                                     'Theft','Property Damage','Other'
                                   )),
  severity             TEXT        NOT NULL DEFAULT 'medium'
                                   CHECK (severity IN ('low','medium','high','critical')),
  title                TEXT        NOT NULL,
  description          TEXT,
  location_text        TEXT,
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  reported_by_user_id  UUID        NOT NULL,
  assigned_to_user_id  UUID,
  status               TEXT        NOT NULL DEFAULT 'open'
                                   CHECK (status IN ('open','assigned','in_progress','resolved','closed')),
  action_taken         TEXT,
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE incident_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_reports FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incident_reports_tenant_isolation ON incident_reports;
CREATE POLICY incident_reports_tenant_isolation ON incident_reports
  USING  (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

CREATE UNIQUE INDEX IF NOT EXISTS incident_reports_number_idx
  ON incident_reports (tenant_id, incident_number);
CREATE INDEX IF NOT EXISTS incident_reports_tenant_idx
  ON incident_reports (tenant_id);
CREATE INDEX IF NOT EXISTS incident_reports_property_status_idx
  ON incident_reports (property_id, status);
CREATE INDEX IF NOT EXISTS incident_reports_reported_by_idx
  ON incident_reports (reported_by_user_id);
CREATE INDEX IF NOT EXISTS incident_reports_occurred_at_idx
  ON incident_reports (occurred_at DESC);
