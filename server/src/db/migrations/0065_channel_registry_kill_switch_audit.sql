-- QYRVIA Phase 53 - Channel Manager Hardening: kill-switch audit columns on
-- channel_registry.
--
-- When an operator disables a channel via the kill switch (PATCH .../status to
-- 'paused' or sets enabled=false via an emergency path), the system must record
-- who triggered the action, when, and why — for audit compliance and incident
-- post-mortems.
--
-- All three columns are additive and nullable:
--   kill_switch_at     — timestamp of the kill-switch activation; NULL when not
--                        activated or after a channel is re-enabled.
--   kill_switch_by     — UUID of the user (staff/admin) who triggered the action.
--   kill_switch_reason — Free-text operator note (required by policy; enforced
--                        at the application layer, not the DB constraint, to
--                        allow automated kill-switch paths without a reason).
--
-- No RLS change required: channel_registry already has a sargable
-- channel_registry_tenant_isolation policy from migration 0051 (recreated from
-- the original 0055 policy). These columns are covered by the existing policy.

BEGIN;

ALTER TABLE channel_registry
  ADD COLUMN IF NOT EXISTS kill_switch_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS kill_switch_by     UUID,
  ADD COLUMN IF NOT EXISTS kill_switch_reason TEXT;

COMMIT;
