-- QYRVIA Phase 53 - Channel Manager Hardening: property-scoped uniqueness on
-- channel_booking_store + conflict audit columns.
--
-- Problem: the existing UNIQUE (tenant_id, channel, external_ref) constraint
-- (named uq_channel_booking_natural from 0045) cannot distinguish the same
-- external_ref arriving for two different properties under one tenant —
-- a multi-property tenant would have a false uniqueness collision.
--
-- Fix: replace the single tenant-wide constraint with two partial unique indexes:
--   1. uq_cbs_natural_property — property-scoped rows (property_id IS NOT NULL)
--      guarantees uniqueness per (tenant, property, channel, external_ref).
--   2. uq_cbs_natural_noprop   — legacy/property-null rows (property_id IS NULL)
--      preserves the original single-property or pre-migration semantic.
--
-- Additive conflict audit columns allow the application to record the reason and
-- timestamp when a conflict is detected without losing the original booking row.
--
-- No data migration: existing rows are unaffected; both partial indexes apply
-- only to future inserts that match their WHERE predicate.

BEGIN;

-- 1) Drop the existing table-level unique constraint (0045)
ALTER TABLE channel_booking_store
  DROP CONSTRAINT IF EXISTS uq_channel_booking_natural;

-- 2) Property-scoped uniqueness (non-null property_id)
CREATE UNIQUE INDEX IF NOT EXISTS uq_cbs_natural_property
  ON channel_booking_store(tenant_id, property_id, channel, external_ref)
  WHERE property_id IS NOT NULL;

-- 3) Legacy / property-null uniqueness (backward compat for rows without property_id)
CREATE UNIQUE INDEX IF NOT EXISTS uq_cbs_natural_noprop
  ON channel_booking_store(tenant_id, channel, external_ref)
  WHERE property_id IS NULL;

-- 4) Conflict audit columns (additive — existing rows remain NULL)
ALTER TABLE channel_booking_store
  ADD COLUMN IF NOT EXISTS conflict_reason TEXT,
  ADD COLUMN IF NOT EXISTS conflict_at     TIMESTAMPTZ;

COMMIT;
