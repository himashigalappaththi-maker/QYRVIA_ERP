# QYRVIA Phase 12 — Reservation Core

> The system of record for bookings, with a deterministic lifecycle,
> idempotency-safe OTA ingestion, and a soft room-hold layer that guarantees
> **zero overbooking under concurrency**. Additive and self-contained; JS /
> CommonJS; zero impact on OTA / Channel Manager / Room Inventory schema.

## Architecture

```
OTA / Channel Manager
      v
Reservation Engine   (truth layer)          src/reservation/core
      v
Room Hold Engine     (temp-lock / race)     src/reservation/holds
      v
Room Inventory Engine (physical state)      src/pms/inventory  (Phase 11, untouched)
```

## Modules (`server/src/reservation/`)

```
models/ReservationModel.js        canonical reservation + STATUS + strict transition map
holds/RoomHoldEngine.js           TTL holds; atomic acquisition; assign/release/expire
repository/reservationRepo.memory.js  in-memory repo + idempotency index + reservation_events
core/ReservationEngine.js         lifecycle orchestration + race-safe room assignment
services/otaIngestionService.js   retry-safe OTA -> reservation bridge
```

## Reservation model

```
{ reservationId, propertyId, guestId,
  source: "booking.com | agoda | direct | qtcn | ...",
  status: CREATED | HELD | CONFIRMED | CANCELLED | CHECKED_IN | COMPLETED,
  checkInDate, checkOutDate, roomCategoryId,
  heldRoomId, assignedRoomId,
  guests: { adults, children },
  pricing: { baseRate, taxes, total },
  idempotencyKey, createdAt, updatedAt }
```

## Lifecycle (deterministic; invalid transitions throw)

```
CREATED -> HELD -> CONFIRMED -> CHECKED_IN -> COMPLETED
                         \-> CANCELLED
```

## Room assignment flow (race-safe)

1. Validate `idempotencyKey` — a repeated key returns the existing reservation.
2. Read availability from the Room Engine for the category + date range.
3. Acquire an **atomic** room HOLD (the overlap check + insert are one
   synchronous critical section — Node is single-threaded, so two concurrent
   callers can never both hold the same room+range).
4. Persist the reservation in **HELD** (`heldRoomId`).
5. On **CONFIRM**: block the room permanently in the Room Engine (a second,
   inventory-level overbooking guard), convert the hold to an assignment
   (`room.assigned`), set `assignedRoomId`.
6. On **any failure**: the hold is released immediately. ACTIVE holds also
   expire by TTL (`expire()` reclaims them, emitting `room.hold_released`).

## Overbooking protection (two layers)

- **Hold layer:** no overlapping ACTIVE/ASSIGNED holds per room (atomic).
- **Inventory layer:** `roomEngine.block()` refuses overlapping confirmed
  ranges.

Result: with one room and two parallel requests, exactly one becomes HELD and
the other gets `no_availability` — verified by the concurrency test.

## Idempotent OTA ingestion

`otaIngestionService.ingest(ctx, booking)` derives a deterministic
`idempotencyKey` (`ota:<source>:<ref>`) from the OTA booking and calls
`createReservation`. Re-delivering the same OTA booking is a no-op that returns
the existing reservation. The Channel Manager is consumed read-only and is not
modified.

## Multi-property isolation (strict)

Every method takes a `ctx` carrying `propertyId`; the reservation repo and the
hold engine are property-scoped. No cross-property reservation is visible or
mutable, and a hold on property A never registers under property B.

## Events

`reservation.created/held/confirmed/cancelled/checked_in/completed`,
`room.hold_created/hold_released/assigned` — emitted through the shared
`eventBus` (single-dot types) into `audit_events` + `event_store` when wired;
also appended to the repo's `reservation_events` log. The engine works without
an event bus (injectable).

## Storage

Store-agnostic via the repo seam (`insert/get/findByIdempotencyKey/update/
list/appendEvent`). Default in-memory. Production persistence is a thin
**additive** layer — `reservations`, `room_holds`, `reservation_events` tables
— added when wiring to the DB; **no** existing table changes, migration chain
stays 0001–0044.

## Tests (`test/reservation.test.js`) — all green

OTA idempotent creation · hold correctness · confirm assigns + blocks room ·
cancel releases hold + room · check-in/complete lifecycle · invalid-transition
rejection · **overbooking prevention under concurrency** · expired-hold
cleanup · multi-property strict isolation.

## Success criteria — met

- ✅ Zero overbooking under concurrency (atomic hold + inventory block).
- ✅ Deterministic hold -> confirm flow.
- ✅ Idempotent OTA ingestion.
- ✅ Room Engine remains a pure physical-state layer (only read + block/release
  + check-in/out are driven; it is never modified).
- ✅ OTA / Channel Manager unchanged; no schema changes; CI fully green.
