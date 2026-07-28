-- QYRVIA Phase 66A (C3) — per-channel dedupe for the outbound sync queue.
--
-- THE DEFECT
-- ──────────
-- 0045_channel_persistence.sql created
--
--     CREATE UNIQUE INDEX uq_csqs_pending
--       ON channel_sync_queue_store(tenant_id, reservation_id, action)
--       WHERE status = 'PENDING';
--
-- That key predates per-OTA fan-out. It was correct when one PMS event produced
-- exactly one job (aimed at the literal 'channel-manager'), and it becomes
-- actively destructive the moment one event fans out to several channels:
-- eight jobs for eight OTAs all collapse onto a single key, so seven channels
-- are silently deduped away and never synced. The failure is invisible — the
-- enqueue simply reports a duplicate.
--
-- A job is identified by (tenant, reservation, action, CHANNEL). The uniqueness
-- contract has to say so.
--
-- WHY WIDENING IS SAFE FOR EXISTING ROWS
-- ──────────────────────────────────────
-- Adding a column to a unique key can only ever ADMIT more rows, never reject
-- rows that already exist: any pair of rows distinguished by the old key stays
-- distinguished by the new one. So there is no historical duplicate to clean up
-- first, and no row is lost or rewritten.
--
-- WHY COALESCE(channel, '')
-- ─────────────────────────
-- `channel` is nullable (0045). In PostgreSQL two NULLs are DISTINCT for
-- uniqueness purposes, so indexing the bare column would silently REMOVE dedupe
-- for any historical channel-less row — unlimited duplicates where there used
-- to be one. Folding NULL onto a sentinel preserves exactly the old behaviour
-- for those rows while giving channel-bearing rows their own key.
--
-- property_id is deliberately NOT part of the key. It is nullable for the same
-- reason, and reservation_id is already unique within a tenant, so adding it
-- would weaken the key for null-property rows without tightening it for anyone.
--
-- ROLLBACK
-- ────────
-- Forward-only, per this repository's convention (no down migrations). To
-- revert, drop uq_csqs_pending_channel and recreate uq_csqs_pending with the
-- original three-column definition — but note that with fan-out live, the old
-- index will reject legitimate per-channel jobs.
--
-- Touches indexes only: no RLS change, no FORCE RLS change, no policy change,
-- no role or privilege change, no column added or dropped, no data rewritten.

BEGIN;

-- The old key. IF EXISTS so a re-run is safe.
DROP INDEX IF EXISTS uq_csqs_pending;

-- One PENDING job per (tenant, reservation, action, channel).
CREATE UNIQUE INDEX IF NOT EXISTS uq_csqs_pending_channel
  ON channel_sync_queue_store (tenant_id, reservation_id, action, COALESCE(channel, ''))
  WHERE status = 'PENDING';

COMMIT;
