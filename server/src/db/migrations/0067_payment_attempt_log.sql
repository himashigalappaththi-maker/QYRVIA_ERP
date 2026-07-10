-- QYRVIA Phase 54 - Payment Attempt Log (D2 / migration 2 of 3).
--
-- Append-only per-attempt record of every payment provider call made during
-- the booking payment flow.
--
-- Design decisions:
--   - Append-only: REVOKE UPDATE, DELETE ... FROM PUBLIC (same pattern as
--     ledger_entries in 0044).
--   - No updated_at column — rows are immutable after insert.
--   - status CHECK constraint is the authoritative vocabulary.
--   - Composite indexes are SARGable: tenant_id leads every index so the
--     planner can use them under RLS (0051 pattern).
--   - RLS uses app_current_tenant() — never current_setting() directly.
--   - FORCE ROW LEVEL SECURITY binds the table owner as well.
--   - All DDL uses IF NOT EXISTS for idempotent re-run safety.

BEGIN;

CREATE TABLE IF NOT EXISTS payment_attempt_log (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID          NOT NULL REFERENCES tenants(id),
  property_id    UUID          NOT NULL,
  reservation_id UUID          NOT NULL REFERENCES reservations(id),
  provider       VARCHAR(60)   NOT NULL,
  amount         NUMERIC(14,2) NOT NULL,
  currency       CHAR(3)       NOT NULL,
  status         VARCHAR(20)   NOT NULL
                   CHECK (status IN ('initiated','success','failed','cancelled')),
  provider_ref   VARCHAR(200),
  error_code     VARCHAR(80),
  error_message  TEXT,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Composite covering index: supports per-reservation attempt history ordered
-- by most-recent-first, scoped to tenant for SARGability.
CREATE INDEX IF NOT EXISTS idx_pal_tenant_reservation
  ON payment_attempt_log (tenant_id, reservation_id, created_at DESC);

-- Composite index: supports provider-level monitoring and status aggregation.
CREATE INDEX IF NOT EXISTS idx_pal_tenant_provider
  ON payment_attempt_log (tenant_id, provider, status, created_at);

-- ---- RLS (0059 / 0051 pattern) --------------------------------------------
ALTER TABLE payment_attempt_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempt_log FORCE  ROW LEVEL SECURITY;

CREATE POLICY pal_tenant_isolation ON payment_attempt_log
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- ---- Append-only enforcement (0044 pattern: REVOKE FROM PUBLIC) -----------
REVOKE UPDATE, DELETE ON payment_attempt_log FROM PUBLIC;

COMMIT;
