# QYRVIA Phase 13 — Front Desk / Stay Lifecycle Engine

> Where the PMS becomes real hotel operations: actual guest presence on top of
> bookings (Phase 12) and room allocation (Phase 11). Additive and
> self-contained; JS / CommonJS; **consumes the Reservation and Room engines
> only — never modifies them**; CI green.

## Stay state machine

```
RESERVATION_CONFIRMED -> CHECKED_IN -> IN_STAY -> CHECKED_OUT
```

A **Stay** is the operational record of a guest's physical presence, derived
from a CONFIRMED reservation. Invalid transitions throw.

## Modules (`server/src/pms/frontdesk/`)

```
StayStateMachine.js   states + transitions + makeStay + in-memory stay store
CheckInService.js     CONFIRMED reservation -> active stay
CheckOutService.js    end stay (standard / early / late)
FrontDeskEngine.js    composes the above + moveRoom + queries
```

## How it consumes the lower engines (no modification)

| Front-desk action | Drives (public API only) | Effect |
|---|---|---|
| `checkInGuest` | `reservationEngine.checkIn` | reservation CONFIRMED→CHECKED_IN; room → OCCUPIED (via Room Engine) |
| `checkOutGuest` | `reservationEngine.complete` | reservation CHECKED_IN→COMPLETED; room → CLEANING (via Room Engine) |
| `moveRoom` | `roomEngine.checkOut` + `roomEngine.checkIn` | old room → CLEANING, new room → OCCUPIED |

The reservation's booking record and the room's physical state remain owned by
Phases 12 / 11; the front desk only calls their public methods and owns the
Stay record.

## Lifecycle + room integration

1. **Check-in** — requires a CONFIRMED reservation. Drives the reservation
   check-in (which occupies the room), creates the Stay (CHECKED_IN → IN_STAY),
   and emits `stay.started` + `room.charge_started` (billing hook prep).
2. **In-stay** — live occupancy is reflected by the Room Engine (OCCUPIED) and
   `roomEngine.occupancy()`.
3. **Check-out** — drives the reservation completion (room → CLEANING) and emits
   `stay.ended` + `housekeeping.queued`. Variants: `earlyCheckOut` (tagged
   EARLY) and `lateCheckOut` (records the extension + emits a `room.charge_started`
   late-fee hook; the checkout itself runs as type LATE).
4. **Room move** — `moveRoom` checks the guest out of the old room (→ CLEANING)
   and into a new room (→ OCCUPIED), updating the Stay; emits `stay.room_moved`
   + `housekeeping.queued` for the vacated room.

## Billing hook preparation (no billing yet)

Phase 13 does not compute charges; it emits the hooks a future billing phase
will consume: **`stay.started`**, **`stay.ended`**, **`room.charge_started`**.

## Housekeeping sync

After checkout (and after a room move) the room goes to CLEANING via the Room
Engine and a `housekeeping.queued` event is emitted for the housekeeping
module.

## Events (single-dot `aggregate.verb`, through the shared eventBus)

`stay.started`, `stay.ended`, `stay.room_moved`, `room.charge_started`,
`housekeeping.queued`.

## Multi-property isolation

Every method takes a `ctx` with `propertyId`; the stay store is property-scoped
and the consumed engines already enforce isolation (a cross-property check-in
raises `reservation_not_found`).

## Tests (`test/pms_frontdesk.test.js`) — all green

Full check-in → in-stay → check-out lifecycle (room OCCUPIED then CLEANING) ·
room move · early checkout · late checkout + billing hook · invalid-operation
rejection · multi-property isolation.

## Constraints honored

- Reservation engine (Phase 12) and Room engine (Phase 11) are **consumed
  only**, never modified.
- JS / CommonJS; no schema changes (migrations stay 0001–0044); CI green.

## Outcome

With Phase 13, QYRVIA is a real operational hotel PMS: booking (12) + room
allocation (11) + actual guest-presence lifecycle (13).
