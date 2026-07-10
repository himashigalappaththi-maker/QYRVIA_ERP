-- QYRVIA Phase 53 - Channel Manager Hardening: reconciliation run ledger.
--
-- One row per reconciliation execution. Provides a durable audit trail of every
-- reconciliation run so that operations can view history, diagnose failures, and
-- correlate ota_drift records (via run_id added in 0063) with the triggering run.
--
-- Design decisions:
--   - trigger_kind CHECK distinguishes operator-triggered, cron-scheduled, and
--     auto-triggered (e.g. post-sync anomaly detection) runs.
--   - status CHECK mirrors channel_sync_lock to keep vocabulary consistent.
--   - drift count columns (inventory/rate/reservation) give a quick summary
--     without requiring a join to ota_drift for dashboards.
--   - max_severity is NULL until the run completes; set by the worker as it
--     processes drift records.
--   - completed_at is NULL while running; set on terminal status transition.
--   - RLS uses app_current_tenant() (SARGable, 0051 pattern).

BEGIN;

CREATE TABLE IF NOT EXISTS channel_reconciliation_run (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  property_id             UUID         REFERENCES properties(id) ON DELETE SET NULL,
  channel_code            VARCHAR(40)  NOT NULL,
  triggered_by            UUID,
  trigger_kind            VARCHAR(12)  NOT NULL DEFAULT 'manual'
                            CHECK (trigger_kind IN ('manual','scheduled','auto')),
  status                  VARCHAR(12)  NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running','completed','failed')),
  inventory_drift_count   INTEGER      NOT NULL DEFAULT 0,
  rate_drift_count        INTEGER      NOT NULL DEFAULT 0,
  reservation_drift_count INTEGER      NOT NULL DEFAULT 0,
  max_severity            VARCHAR(8)
                            CHECK (max_severity IN ('info','warn','error','critical')),
  started_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at            TIMESTAMPTZ,
  error_message           TEXT
);

-- Covering index for per-tenant per-channel run history (newest-first)
CREATE INDEX IF NOT EXISTS ix_crr_tenant_channel
  ON channel_reconciliation_run(tenant_id, channel_code, started_at DESC);

ALTER TABLE channel_reconciliation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_reconciliation_run FORCE  ROW LEVEL SECURITY;

-- SARGable isolation policy: SELECT/INSERT/UPDATE all scoped to the current tenant
CREATE POLICY channel_reconciliation_run_tenant_isolation
  ON channel_reconciliation_run
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

COMMIT;
