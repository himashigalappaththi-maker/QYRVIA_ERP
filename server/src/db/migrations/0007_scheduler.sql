-- QYRVIA Phase 3 - scheduler / job runtime.

CREATE TYPE scheduled_job_status AS ENUM (
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
);

CREATE TABLE scheduled_jobs (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  property_id  UUID         REFERENCES properties(id),
  job_type     VARCHAR(120) NOT NULL,
  payload      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  run_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  status       scheduled_job_status NOT NULL DEFAULT 'pending',
  attempts     INTEGER      NOT NULL DEFAULT 0,
  max_attempts INTEGER      NOT NULL DEFAULT 3,
  last_error   TEXT,
  locked_by    VARCHAR(120),                    -- worker identity that picked up the row
  locked_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by   UUID
);
CREATE INDEX idx_scheduled_jobs_due       ON scheduled_jobs(status, run_at) WHERE status = 'pending';
CREATE INDEX idx_scheduled_jobs_tenant    ON scheduled_jobs(tenant_id, created_at DESC);

ALTER TABLE scheduled_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_jobs FORCE  ROW LEVEL SECURITY;
CREATE POLICY scheduled_jobs_by_app ON scheduled_jobs
  USING (tenant_id::text = current_setting('app.tenant_id', true));
