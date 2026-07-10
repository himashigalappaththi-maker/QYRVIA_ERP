-- QYRVIA Phase 54 - Reservation Hardening (D2 / migration 3 of 3).
--
-- Additive columns on reservations — no existing columns are modified.
-- All columns are nullable so no backfill of historical rows is required.
--
-- Columns added:
--   idempotency_key     — caller-supplied key that guarantees exactly-once
--                         booking creation per tenant; enforced by partial
--                         unique index (only non-NULL keys are constrained).
--   snapshotted_rate    — rate locked at booking creation time (immutable
--                         after confirmation, survives future rate-plan edits).
--   snapshotted_currency — currency of the snapshotted rate.
--   confirmation_number — human-readable confirmation sent to the guest;
--                         unique per property (partial, non-NULL only).
--   confirmation_sent_at — timestamp when the confirmation was dispatched.
--
-- Indexes:
--   uq_reservations_idempotency   — partial UNIQUE on (tenant_id, idempotency_key)
--   uq_reservations_confirmation  — partial UNIQUE on (property_id, confirmation_number)
--   idx_reservations_source_channel — regular index on (property_id, source_channel)
--                                     for channel-manager query patterns; source_channel
--                                     column was added in migration 0022.
--
-- All DDL uses IF NOT EXISTS for idempotent re-run safety.
-- No RLS changes: reservations table already has ENABLE + FORCE RLS with a
-- policy (migration 0019); that policy is not modified here.

BEGIN;

-- ---- New columns -----------------------------------------------------------
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS idempotency_key     VARCHAR(512);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS snapshotted_rate     NUMERIC(14,2);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS snapshotted_currency CHAR(3);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS confirmation_number  VARCHAR(40);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ;

-- ---- Indexes ---------------------------------------------------------------

-- Exactly-once booking guard: one idempotency key per tenant.
-- Partial: NULL keys are excluded (un-keyed bookings are unrestricted).
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservations_idempotency
  ON reservations (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Confirmation number uniqueness scoped to property.
-- Partial: NULL confirmation numbers are excluded.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservations_confirmation
  ON reservations (property_id, confirmation_number)
  WHERE confirmation_number IS NOT NULL;

-- SARGable index for channel-manager queries filtering by source_channel.
-- source_channel column exists since migration 0022.
CREATE INDEX IF NOT EXISTS idx_reservations_source_channel
  ON reservations (property_id, source_channel);

COMMIT;
