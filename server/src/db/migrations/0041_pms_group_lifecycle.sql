-- QYRVIA Phase 7 / C5 - Group Reservation Lifecycle.
--
-- WHY: Phase 5.5 reserved reservation_groups + reservations.group_id;
-- Phase 7 adds the lifecycle commands and the queries used to operate on
-- a group as a whole (rooming list, cancel all, check-in all). The index
-- below speeds the rooming-list query.

CREATE INDEX IF NOT EXISTS idx_reservations_group_status
  ON reservations(group_id, status) WHERE group_id IS NOT NULL;

-- Permission `reservation.group.write` was already seeded in migration 0030.
