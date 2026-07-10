-- QYRVIA Phase 53 - Channel Manager Hardening: max_retries cap + dequeue
-- backoff index on channel_sync_queue_store.
--
-- max_retries: sets an explicit per-job ceiling on how many delivery attempts
-- the channel worker will make before moving the job to the dead-letter store.
-- Default 4 matches the existing retry behaviour documented in the channel
-- worker. The column is additive; existing rows inherit the default.
--
-- Dequeue backoff index: the existing idx_csqs_poll (status, next_run_at) does
-- not lead on tenant_id, making it non-SARGable for per-tenant worker queries.
-- The new ix_csqs_dequeue_backoff leads on (tenant_id, property_id, next_retry_at)
-- filtered to PENDING rows — the exact predicate used by the polling worker
-- when it picks up jobs for a specific property scope.

BEGIN;

ALTER TABLE channel_sync_queue_store
  ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 4;

-- Tenant-scoped dequeue index: supports per-tenant/property PENDING job polling
-- ordered by next_retry_at (earliest-due first)
CREATE INDEX IF NOT EXISTS ix_csqs_dequeue_backoff
  ON channel_sync_queue_store(tenant_id, property_id, next_retry_at)
  WHERE status = 'PENDING';

COMMIT;
