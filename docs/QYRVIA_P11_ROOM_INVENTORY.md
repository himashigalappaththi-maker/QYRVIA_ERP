# QYRVIA PMS Phase 11 — Room & Inventory Engine

> The truth layer for physical hotel capacity: room categories, floors,
> dynamically-generated rooms, deterministic availability, occupancy tracking,
> housekeeping sync, and strict multi-property isolation.
>
> **Additive and self-contained.** It does not modify the Phase 5 `rooms`
> table, the `room_status` enum, or any existing PMS code, and has **zero
> impact on the OTA / Channel Manager / QTCN system**. JS / CommonJS.

## Modules (`server/src/pms/`)

```
rooms/RoomModel.js                  canonical Room + STATUS/HOUSEKEEPING enums
inventory/roomStore.memory.js       store interface (property-scoped); default backing
inventory/RoomInventoryEngine.js    generate-from-config, lifecycle, blocking, queries, events
inventory/AvailabilityCalculator.js pure deterministic availability
inventory/OccupancyTracker.js       pure occupancy stats
housekeeping/HousekeepingSyncService.js  housekeeping seam onto the engine
```

## Canonical Room

```
{ roomId, propertyId, categoryId, floorId, roomNumber,
  status: AVAILABLE | OCCUPIED | CLEANING | MAINTENANCE,
  housekeepingState: CLEAN | DIRTY | INSPECTED,
  currentReservationId, lastUpdated }
```

## Dynamic generation

Rooms are **not static** — they are generated from per-property config:

```js
await engine.generateRooms(ctx, [
  { categoryId: 'DELUXE', floorId: 'F1', floorNumber: 1, count: 10 },  // 101..110
  { categoryId: 'STD',    floorId: 'F2', floorNumber: 2, count: 20 }   // 201..220
]);
```

`roomNumber = floorNumber*100 + seq`. Each room emits `room.created`.

## Lifecycle (single source of truth for room status)

| Action | Transition | Events |
|---|---|---|
| `checkIn`  | AVAILABLE → OCCUPIED (sets `currentReservationId`) | `room.occupied`, `room.status_changed` |
| `checkOut` | OCCUPIED → CLEANING (`housekeepingState=DIRTY`) | `room.status_changed` |
| `cleaningComplete` | CLEANING → AVAILABLE (`housekeepingState=CLEAN`) | `room.cleaned`, `room.status_changed` |
| `setMaintenance` / `clearMaintenance` | ↔ MAINTENANCE | `room.status_changed` |

Invalid transitions (e.g. check-in on a non-AVAILABLE room) are rejected.
Events flow through the shared `eventBus` (single-dot `room.*` types) into
`audit_events` + `event_store` when wired; the engine works without an event
bus too (it is injectable).

## Deterministic availability + overbooking prevention

A room is AVAILABLE for `[dateFrom, dateTo)` iff it is **not OCCUPIED**, **not
under MAINTENANCE**, and **not blocked by an overlapping reservation range**.

`block(ctx, { roomId, dateFrom, dateTo, reservationId })` reserves a room and
**refuses an overlapping block** → no double booking is possible. `release()`
frees a held block. (Reservation persistence + the booking flow arrive in
Phase 12; the engine already exposes the blocking primitive as the integration
point.)

## Multi-property isolation (strict)

Every engine method takes a `ctx` carrying `propertyId`; the store is
property-scoped. There is **no cross-property visibility or mutation**: listing
under another property returns nothing, fetching another property's room
returns `null`, and mutating it raises `room_not_found`. A missing `propertyId`
raises `property_required`.

## Integration points

- **Reservation system (Phase 12):** will call `block`/`release` and
  `checkIn`/`checkOut`.
- **Channel Manager:** `availability(ctx, range)` is the source for an
  availability push (the CM remains execution-only).
- **Housekeeping module:** `HousekeepingSyncService` drives cleaning /
  maintenance transitions and the engine emits the status events.

## Storage

The engine is **store-agnostic** via the `roomStore` interface
(`insert/get/list/update`, all property-scoped). The default is in-memory.
Production persistence is a thin additive layer — a `roomStore.pg.js` backed by
an **additive** `room_inventory` migration — added when wiring to the DB; no
existing table or migration changes, and the migration chain stays 0001–0044.

## Tests (`test/pms_inventory.test.js`) — all green

Room generation from config · deterministic availability · check-in/out +
cleaning lifecycle · invalid-transition rejection · housekeeping state
transitions · multi-property isolation · overbooking prevention · occupancy
snapshot.

## Success criteria — met

- ✅ 100% deterministic availability (pure calculator).
- ✅ No double booking possible (overlapping blocks refused).
- ✅ Clean lifecycle state transitions (guarded; single source of truth).
- ✅ Fully CI green; zero impact on OTA / Channel Manager / QTCN; no schema
  changes.
