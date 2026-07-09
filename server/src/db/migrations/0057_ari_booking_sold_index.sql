-- QYRVIA Phase 52 - ARI Booking Engine Commercial Core: covering index.
--
-- WHY: The booking engine drives two hot paths against ari_inventory_grid:
--
--   adjustSold  — point UPDATE: tenant_id + property_id + room_type_id + date
--                 (increments sold, checks physical - sold - blocked >= 0).
--
--   quoteStay   — range SELECT: tenant_id + property_id + room_type_id,
--                 date BETWEEN checkin AND checkout - 1.
--                 Reads sold, physical, blocked, stop_sell for every night
--                 of the requested stay.
--
-- The primary key (tenant_id, property_id, room_type_id, date) already makes
-- the adjustSold point-lookup and the quoteStay range-scan index-efficient;
-- what is missing is an INCLUDE clause so that the executor can satisfy the
-- SELECT with an index-only scan and never touch the heap.
--
-- The index is named deterministically so IF NOT EXISTS is safe and the
-- migration can be re-run without error.
--
-- Additive only — no ALTER TABLE, no DROP.

CREATE INDEX IF NOT EXISTS ix_ari_inventory_grid_booking
    ON ari_inventory_grid (tenant_id, property_id, room_type_id, date)
    INCLUDE (sold, physical, blocked, stop_sell);
