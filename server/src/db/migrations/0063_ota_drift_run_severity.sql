-- QYRVIA Phase 53 - Channel Manager Hardening: link ota_drift rows to a
-- reconciliation run and add per-drift severity classification.
--
-- Why run_id: allows the reconciliation worker to atomically associate every
-- drift record it produces with the channel_reconciliation_run row that owns
-- it, enabling precise per-run drill-down without a time-range join.
--
-- Why severity: lets the reconciliation engine classify drift urgency
-- independently of drift_kind. 'critical' may trigger an alert; 'info' is
-- logged but suppressed from operator dashboards by default.
--
-- Both columns are additive; existing ota_drift rows are unaffected:
--   - run_id  defaults to NULL (no associated run — legacy / manual inserts)
--   - severity defaults to 'warn' (safe, visible, non-critical)

BEGIN;

ALTER TABLE ota_drift
  ADD COLUMN IF NOT EXISTS run_id   UUID
    REFERENCES channel_reconciliation_run(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS severity VARCHAR(8) DEFAULT 'warn'
    CHECK (severity IN ('info','warn','error','critical'));

-- Run-scoped lookup: all drift rows for a given reconciliation run
CREATE INDEX IF NOT EXISTS ix_od_run
  ON ota_drift(tenant_id, run_id)
  WHERE run_id IS NOT NULL;

-- Severity + channel + time: supports dashboard filtered queries
CREATE INDEX IF NOT EXISTS ix_od_severity
  ON ota_drift(tenant_id, channel, severity, detected_at);

COMMIT;
