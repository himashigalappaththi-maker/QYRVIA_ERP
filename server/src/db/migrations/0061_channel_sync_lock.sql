-- QYRVIA Phase 53 - Channel Manager Hardening: advisory lock table for
-- preventing parallel full-sync / reconciliation runs.
--
-- Design decisions:
--   - lock_type CHECK constraint limits the vocabulary to known operation classes.
--   - uq_csl_active partial unique index allows only ONE 'running' lock per
--     (tenant, property, channel, lock_type) tuple at a time; completed/expired
--     rows are historical and do not block new acquisitions.
--   - expires_at enables dead-lock recovery: a sweeper can mark locks as 'expired'
--     when now() > expires_at and status = 'running'.
--   - ix_csl_tenant_expires supports the expiry sweeper index scan.
--   - RLS uses app_current_tenant() (SARGable, 0051 pattern); SELECT/INSERT/UPDATE
--     policy allows lock lifecycle management within the tenant boundary.

BEGIN;

CREATE TABLE IF NOT EXISTS channel_sync_lock (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  property_id  UUID         REFERENCES properties(id) ON DELETE SET NULL,
  channel_code VARCHAR(40)  NOT NULL,
  lock_type    VARCHAR(30)  NOT NULL
                 CHECK (lock_type IN ('reconciliation','bulk_push','full_sync')),
  lock_holder  VARCHAR(255),
  acquired_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ  NOT NULL,
  status       VARCHAR(12)  NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','completed','expired'))
);

-- Prevent two concurrent running locks of the same type for the same scope
CREATE UNIQUE INDEX IF NOT EXISTS uq_csl_active
  ON channel_sync_lock(tenant_id, property_id, channel_code, lock_type)
  WHERE status = 'running';

-- Expiry sweeper index: find all stale running locks quickly
CREATE INDEX IF NOT EXISTS ix_csl_tenant_expires
  ON channel_sync_lock(tenant_id, expires_at)
  WHERE status = 'running';

ALTER TABLE channel_sync_lock ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_sync_lock FORCE  ROW LEVEL SECURITY;

-- SARGable isolation policy: SELECT/INSERT/UPDATE all scoped to the current tenant
CREATE POLICY channel_sync_lock_tenant_isolation
  ON channel_sync_lock
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

COMMIT;
