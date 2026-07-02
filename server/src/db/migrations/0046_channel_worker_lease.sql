-- QYRVIA Phase 24 (B6) - durable queue worker lease/retry fields. DEFINITION ONLY:
-- additive columns on channel_sync_queue_store; nothing selects them until the DB
-- worker stage is activated (CHANNEL_PERSISTENCE=db + CHANNEL_WORKER_ENABLED=true).
--
-- lease_until already exists (0045). Worker leasing claims a PENDING/recoverable job by
-- setting status='PROCESSING', lease_owner, lease_until; an expired lease is recoverable.

ALTER TABLE channel_sync_queue_store
  ADD COLUMN lease_owner   VARCHAR(80),
  ADD COLUMN retry_count   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN next_retry_at TIMESTAMPTZ;

CREATE INDEX idx_csqs_lease ON channel_sync_queue_store(status, lease_until);
CREATE INDEX idx_csqs_retry ON channel_sync_queue_store(status, next_retry_at);
