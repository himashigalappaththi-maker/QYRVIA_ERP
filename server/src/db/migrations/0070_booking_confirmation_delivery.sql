-- QYRVIA Phase 56 — Booking Confirmation Delivery Outbox
--
-- Two additions:
--   1. booking_confirmation_deliveries — persistent outbox for booking-confirmation
--      delivery. Supports durable retries, deduplication, bounded retry policy,
--      and confirmation_sent_at semantics.
--   2. Partial UNIQUE index on scheduled_jobs(tenant_id, job_type) WHERE
--      status IN ('pending','running') — prevents duplicate sweep jobs when
--      bootstrap.js is re-run or tenant creation is retried concurrently.
--
-- RLS: uses app_current_tenant() (SARGable, 0051/0059 pattern). Never
--      current_setting() directly.
-- FORCE ROW LEVEL SECURITY binds the table owner as well.
-- All DDL uses IF NOT EXISTS / idempotency guards for safe re-run.

BEGIN;

-- ---- 1. Status enum for confirmation delivery --------------------------------

DO $$ BEGIN
  CREATE TYPE booking_confirmation_delivery_status AS ENUM (
    'pending',
    'processing',
    'sent',
    'retryable_failure',
    'permanent_failure',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---- 2. booking_confirmation_deliveries table --------------------------------
--
-- One row per (tenant, reservation, notification_type, channel, recipient).
-- Deduplication is enforced by the UNIQUE constraint on (tenant_id, dedup_key).
--
-- Recommended dedup_key format (computed by the application):
--   {reservation_id}:{notification_type}:{channel}:{recipient}
--
-- Status lifecycle:
--   pending → processing → sent                  (happy path)
--   pending → processing → retryable_failure      (temporary error; next_attempt_at set)
--   pending → processing → permanent_failure       (exhausted max_attempts or hard error)
--   pending → cancelled                           (booking cancelled before delivery)
--
-- confirmation_sent_at on reservations is set only when status transitions to 'sent'.

CREATE TABLE IF NOT EXISTS booking_confirmation_deliveries (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES tenants(id),
  property_id         UUID         REFERENCES properties(id),
  reservation_id      UUID         NOT NULL REFERENCES reservations(id),
  confirmation_number VARCHAR(40),
  channel             notification_channel NOT NULL,
  recipient           VARCHAR(200) NOT NULL,
  notification_type   VARCHAR(120) NOT NULL DEFAULT 'booking_confirmation',
  context             JSONB        NOT NULL DEFAULT '{}',
  dedup_key           VARCHAR(512) NOT NULL,
  status              booking_confirmation_delivery_status NOT NULL DEFAULT 'pending',
  attempt_count       INTEGER      NOT NULL DEFAULT 0,
  max_attempts        INTEGER      NOT NULL DEFAULT 3,
  next_attempt_at     TIMESTAMPTZ,
  last_error          TEXT,
  provider_ref        VARCHAR(200),
  locked_by           VARCHAR(120),
  locked_at           TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_booking_confirmation_dedup UNIQUE (tenant_id, dedup_key)
);

-- Pending-delivery scan (worker polling)
CREATE INDEX IF NOT EXISTS idx_bcd_tenant_status
  ON booking_confirmation_deliveries (tenant_id, status)
  WHERE status IN ('pending', 'processing');

-- Reservation lookup (cancel + status queries)
CREATE INDEX IF NOT EXISTS idx_bcd_reservation
  ON booking_confirmation_deliveries (reservation_id);

-- Retry scheduling
CREATE INDEX IF NOT EXISTS idx_bcd_next_attempt
  ON booking_confirmation_deliveries (next_attempt_at)
  WHERE status = 'pending' AND next_attempt_at IS NOT NULL;

-- ---- RLS (0051/0059/0066 pattern) --------------------------------------------

ALTER TABLE booking_confirmation_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_confirmation_deliveries FORCE  ROW LEVEL SECURITY;

CREATE POLICY bcd_tenant_isolation ON booking_confirmation_deliveries
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- ---- 3. Idempotency guard on scheduled_jobs ----------------------------------
--
-- Prevents duplicate booking.hold.expire_sweep rows per tenant. Without this
-- index a concurrent bootstrap (or manual re-seed) could insert a second sweep
-- job for the same tenant before the first is picked up by a worker.
--
-- Partial on status IN ('pending','running'): terminal rows (completed, failed,
-- cancelled, dead_letter) do not block a fresh job for the same type/tenant.
-- Recurring sweep jobs cycle pending→running→pending and never reach 'completed'.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'scheduled_jobs'
       AND indexname  = 'uq_scheduled_jobs_active_per_tenant_type'
  ) THEN
    CREATE UNIQUE INDEX uq_scheduled_jobs_active_per_tenant_type
      ON scheduled_jobs (tenant_id, job_type)
      WHERE status IN ('pending', 'running');
  END IF;
END $$;

COMMIT;
