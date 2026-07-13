-- Phase 58 — Notification retry, worker lease, and stale-claim recovery
-- 0076_notification_retry.sql
--
-- Adds retry/lease fields to the existing `notifications` table (migration 0008).
-- No enum changes — 'pending' is reused for retry-scheduled rows (controlled by
-- next_attempt_at); 'sending' continues to mean "claimed by a worker".
--
-- Atomic claim pattern:
--   WITH due AS (
--     SELECT id FROM notifications
--      WHERE (status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
--         OR (status='sending' AND locked_at < now() - INTERVAL '10 minutes')
--      ORDER BY requested_at LIMIT $1 FOR UPDATE SKIP LOCKED
--   )
--   UPDATE notifications n
--      SET status='sending', locked_by=$2, locked_at=now()
--     FROM due WHERE n.id=due.id
--   RETURNING n.*
--
-- attempt_count is incremented ONCE immediately before a real provider send,
-- never at claim or stale-recovery time.

BEGIN;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS attempt_count             INTEGER     NOT NULL DEFAULT 0
                           CHECK (attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS max_attempts              INTEGER     NOT NULL DEFAULT 3
                           CHECK (max_attempts >= 1),
  ADD COLUMN IF NOT EXISTS next_attempt_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by                 VARCHAR(120),
  ADD COLUMN IF NOT EXISTS locked_at                 TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_message_id       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS provider_idempotency_key  VARCHAR(255);

-- Enforce attempt ceiling at the DB level
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'notifications_attempt_count_le_max'
       AND conrelid = 'notifications'::regclass
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT notifications_attempt_count_le_max
        CHECK (attempt_count <= max_attempts);
  END IF;
END;
$$;

-- Index for polling due pending rows (next_attempt_at IS NULL = first attempt)
CREATE INDEX IF NOT EXISTS idx_notifications_retry_due
  ON notifications (next_attempt_at NULLS FIRST, requested_at)
  WHERE status = 'pending';

-- Index for stale-lease recovery (stuck 'sending' rows)
CREATE INDEX IF NOT EXISTS idx_notifications_stale_sending
  ON notifications (locked_at)
  WHERE status = 'sending';

COMMIT;
