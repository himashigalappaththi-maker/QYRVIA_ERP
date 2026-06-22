-- QYRVIA Phase 4 - production scheduler upgrade.
-- Adds cron recurrence + dead-letter state to scheduled_jobs.

ALTER TYPE scheduled_job_status ADD VALUE IF NOT EXISTS 'dead_letter';

ALTER TABLE scheduled_jobs
  ADD COLUMN recurrence_rule    VARCHAR(120),                  -- e.g. '0 3 * * *' (cron) or NULL for one-shot
  ADD COLUMN timezone           VARCHAR(80) NOT NULL DEFAULT 'UTC',
  ADD COLUMN next_run_at        TIMESTAMPTZ,                   -- set on completion of a recurring job to next scheduled time
  ADD COLUMN dead_letter_reason TEXT;

-- A small audit table that records every run of a recurring job (the
-- main scheduled_jobs row keeps the latest snapshot; this gives history).
CREATE TABLE scheduled_job_recurrence (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       UUID         NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  run_started  TIMESTAMPTZ  NOT NULL,
  run_finished TIMESTAMPTZ,
  status       scheduled_job_status NOT NULL,
  error        TEXT
);
CREATE INDEX idx_scheduled_job_recurrence_job ON scheduled_job_recurrence(job_id, run_started DESC);

ALTER TABLE scheduled_job_recurrence ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_job_recurrence FORCE  ROW LEVEL SECURITY;
CREATE POLICY scheduled_job_recurrence_by_app ON scheduled_job_recurrence
  USING (tenant_id::text = current_setting('app.tenant_id', true));
