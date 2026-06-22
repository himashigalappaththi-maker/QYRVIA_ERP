-- QYRVIA Architecture Hardening (Phase 5.5) - Night Audit / Day-End.
--
-- WHY: Every QYRVIA module that posts financial-significant data
--      (folio, POS, finance, channel reconciliation) must know:
--        1) the current business_date,
--        2) whether the business_date is LOCKED (mid-audit),
--        3) the historical audit-run log.
--      The commandBus enforces (1) and (2) via the `accountingSensitive`
--      attribute; the table below provides (3).

CREATE TYPE night_audit_status AS ENUM ('PENDING','RUNNING','COMPLETED','FAILED');

CREATE TABLE night_audit_runs (
  id                       UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID                NOT NULL REFERENCES tenants(id),
  property_id              UUID                NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  business_date            DATE                NOT NULL,    -- the date being CLOSED
  next_business_date       DATE                NOT NULL,
  status                   night_audit_status  NOT NULL DEFAULT 'PENDING',
  triggered_by             UUID,                            -- NULL = scheduler
  trigger_kind             VARCHAR(20)         NOT NULL DEFAULT 'MANUAL',  -- MANUAL | AUTO
  started_at               TIMESTAMPTZ         NOT NULL DEFAULT now(),
  completed_at             TIMESTAMPTZ,
  duration_ms              INTEGER,
  reservations_arrived     INTEGER             NOT NULL DEFAULT 0,
  reservations_departed    INTEGER             NOT NULL DEFAULT 0,
  reservations_no_show     INTEGER             NOT NULL DEFAULT 0,
  rooms_charged            INTEGER             NOT NULL DEFAULT 0,
  total_room_revenue       NUMERIC(14,2)       NOT NULL DEFAULT 0,
  error                    TEXT,
  notes                    TEXT,
  payload                  JSONB               NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX ux_night_audit_property_busdate ON night_audit_runs(property_id, business_date);
CREATE INDEX idx_night_audit_property_completed ON night_audit_runs(property_id, completed_at DESC);

ALTER TABLE night_audit_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE night_audit_runs FORCE  ROW LEVEL SECURITY;
CREATE POLICY night_audit_runs_by_app ON night_audit_runs
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- Convenience helper - mark business date locked / unlocked is done via
-- existing properties.business_date_locked column from migration 0005.
-- This migration only adds the run history + the type to record outcomes.
