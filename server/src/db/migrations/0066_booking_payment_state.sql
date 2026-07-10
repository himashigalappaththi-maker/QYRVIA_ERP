-- QYRVIA Phase 54 - Booking Payment State (D2 / migration 1 of 3).
--
-- Part A: Extend reservation_status enum with two payment-flow values.
-- Part B: New table booking_payment_state — one row per reservation that
--         enters the payment flow, with SARGable RLS following the 0051/0059
--         app_current_tenant() pattern.
--
-- Design decisions:
--   - UNIQUE on reservation_id enforces 1:1 with reservations.
--   - Partial index on (tenant_id, hold_expires_at) scoped to
--     payment_status = 'pending_payment' supports the hold-expiry sweep
--     without scanning paid/failed rows.
--   - RLS uses app_current_tenant() — never current_setting() directly.
--   - FORCE ROW LEVEL SECURITY binds the table owner as well.
--   - All DDL uses IF NOT EXISTS for idempotent re-run safety.

-- ---- Part A: enum extension ------------------------------------------------
-- ADD VALUE IF NOT EXISTS is safe outside a transaction block in Postgres 12+.
-- We use the DO block pattern (EXCEPTION WHEN duplicate_object) as a belt-and-
-- suspenders guard consistent with older enum extensions in this codebase.

DO $$ BEGIN
  ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'PAYMENT_FAILED';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---- Part B: booking_payment_state table -----------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS booking_payment_state (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID          NOT NULL REFERENCES tenants(id),
  property_id       UUID          NOT NULL,
  reservation_id    UUID          NOT NULL REFERENCES reservations(id),
  payment_status    VARCHAR(20)   NOT NULL
                      CHECK (payment_status IN ('pending_payment','paid','failed','refunded')),
  deposit_amount    NUMERIC(14,2),
  deposit_currency  CHAR(3),
  hold_expires_at   TIMESTAMPTZ,
  provider          VARCHAR(60),
  provider_ref      VARCHAR(200),
  paid_at           TIMESTAMPTZ,
  failed_at         TIMESTAMPTZ,
  refunded_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- One payment-state row per reservation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bps_reservation
  ON booking_payment_state (reservation_id);

-- SARGable index: hold-expiry sweep (partial — only pending rows are swept).
CREATE INDEX IF NOT EXISTS idx_bps_hold_expiry
  ON booking_payment_state (tenant_id, hold_expires_at)
  WHERE payment_status = 'pending_payment';

-- SARGable covering index: tenant-scoped reservation lookup.
CREATE INDEX IF NOT EXISTS idx_bps_tenant_reservation
  ON booking_payment_state (tenant_id, reservation_id);

-- ---- RLS (0059 / 0051 pattern) --------------------------------------------
ALTER TABLE booking_payment_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_payment_state FORCE  ROW LEVEL SECURITY;

CREATE POLICY bps_tenant_isolation ON booking_payment_state
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

COMMIT;
