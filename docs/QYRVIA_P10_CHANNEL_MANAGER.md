# QYRVIA Phase 10.0 — Channel Manager Foundation

> First production-grade distribution layer on top of the PMS + the Phase 9.1
> CI-verified PostgreSQL truth layer. Implemented in **JavaScript / CommonJS**
> to match the existing backend (the brief's `.ts` layout maps 1:1 onto `.js`;
> no TypeScript toolchain was introduced — confirmed with the requester).

## Folder structure (`server/src/channel-manager/`)

```
core/
  ChannelManagerCore.js          adapter registry + orchestration + conflict gateway
  canonical/
    CanonicalBooking.js  CanonicalRate.js  CanonicalInventory.js  types.js
  events/
    ChannelEventBus.js  events.js  EventTypes.js
  sync/
    SyncEngine.js  RetryPolicy.js  QueueManager.js
adapters/
  base/OTAAdapter.js               contract + assertImplements()
  bookingcom/BookingComAdapter.js  + bookingcom.mock.js   (working mock)
  agoda/AgodaAdapter.js  expedia/ExpediaAdapter.js  airbnb/AirbnbAdapter.js   (stubs)
  qyrcn/QTCNAdapter.js             internal first-class channel
services/
  InventoryService.js  RateService.js  BookingService.js  ConflictResolver.js
api/
  channel.routes.js  channel.controller.js
```

Tests live in `server/test/channel_*.test.js` (so the existing `node --test`
CI job runs them); the brief's `channel-manager/tests/` intent is satisfied
there.

## Core design rules — how each is met

1. **Canonical model.** Every adapter returns `CanonicalBooking` /
   `CanonicalRate` / `CanonicalInventory`. No OTA-specific field crosses an
   adapter boundary; the core + services only speak canonical.
2. **Adapter pattern (strict).** `OTAAdapter` defines the six-method contract;
   `assertImplements()` is enforced at `registerAdapter()` and by
   `channel_adapter_contract.test.js` for every present/future adapter.
3. **Sync engine.** `QueueManager` provides queue-based processing,
   idempotency keys (op runs at most once), exponential backoff
   (`RetryPolicy`), partial-failure isolation (one job's terminal failure is
   dead-lettered, others continue), and per-OTA rate limiting (min interval per
   channel). `SyncEngine` adds **delta sync** (unchanged rate/inventory is
   skipped — no full resync loops). The core never calls an OTA directly.
4. **Event system / DB integration.** `ChannelEventBus` wraps the shared
   `core/eventBus` rather than inventing a parallel bus, so channel events
   (`channel.booking_created`, `channel.booking_cancelled`,
   `channel.inventory_updated`, `channel.rate_updated`) are **persisted** to
   `audit_events` + `event_store` (append-only), **replayable** (pure reducer
   in `BookingService.reducer`, proven in `channel_event_replay.test.js`), and
   **idempotent** (idempotency keys + dedup ingest). They ride the same
   transaction/persistence path as every other domain event.

> Event-name note: the kernel's `makeEvent` enforces a single-dot
> `aggregate.verb` type, so `BookingCreated` → `channel.booking_created`, etc.

## QTCN — QYRVIA Travel Commerce Network (design)

QTCN is QYRVIA's **own** distribution channel, implemented as a first-class
`OTAAdapter` so the core treats it uniformly — but it is fundamentally
different from an external OTA:

- **Zero commission** (`commissionPct = 0`): direct revenue, no OTA cut.
- **Fastest sync path**: pushes are in-process — no external HTTP/XML, no vendor
  rate limits, no network latency — so they resolve immediately and are
  authoritative on return (real-time inventory).
- **Bookings originate inside QYRVIA** (web/app/front desk), so `pullBookings`
  reads an internal source rather than a remote API.
- **Conflict priority**: when two channels claim the same slot, `ConflictResolver`
  awards QTCN the win (`qtcn_priority`) — protecting direct revenue.

## API (mounted at `/api/channel`, RBAC via reserved `channel.*` perms)

| Method | Path | Permission |
|---|---|---|
| POST | `/channel/sync/rates` | `channel.sync.run` |
| POST | `/channel/sync/inventory` | `channel.sync.run` |
| POST | `/channel/bookings/sync` | `channel.sync.run` |
| POST | `/channel/bookings/confirm` | `channel.sync.run` |
| POST | `/channel/bookings/cancel` | `channel.sync.run` |
| GET  | `/channel/status` | `channel.mapping.read` |

`channel.sync.run` / `channel.mapping.read` are already seeded (migration
0030), so Phase 10.0 adds **no migration** — the 0001–0044 chain and the green
Phase 9.1 CI are untouched.

## CI test plan (extends Phase 9.1)

In-memory unit job (`npm run test:unit`) runs:
- `channel_canonical.test.js` — canonical model validation
- `channel_adapter_contract.test.js` — adapter contract compliance (all 5 channels)
- `channel_sync_engine.test.js` — idempotency, retry/backoff, partial-failure
  isolation, per-OTA rate limiting, delta sync
- `channel_booking_conflict.test.js` — conflict resolution (QTCN priority,
  confirmed-beats-pending, dedupe)
- `channel_event_replay.test.js` — events persist via eventBus + replay into
  state (idempotent fold)

The Phase 9.1 `db` job is unchanged: PostgreSQL service, migrations 0001–0044,
`npm run test:db`. Because channel events persist through the existing
`event_store`, DB-level durability/replay is already covered by that layer.

## Integration points with the Phase 9.1 DB truth layer

- **Events → `event_store`**: `ChannelEventBus` publishes through `core/eventBus`,
  whose persistent subscriber writes every domain event to `audit_events` +
  `event_store` (append-only, `REVOKE UPDATE,DELETE` — verified in Phase 9.1).
- **No new schema**: reuses existing tables + seeded permissions; the verified
  migration chain stays at 0001–0044.
- **Future bookings → folios/ledger**: `CanonicalBooking` carries
  `propertyId`, `roomTypeId`, `amount`, `currency`, `commissionPct`, so a later
  phase can route confirmed bookings into the PMS reservation/folio flow and the
  Phase 8 ledger without changing the canonical model.

## Status

- Channel Manager core exists; adapter registry + orchestration + conflict
  gateway working.
- Booking.com mock adapter works end-to-end (pull → canonical → ingest → events).
- QTCN defined as the internal, zero-commission distribution engine.
- Agoda / Expedia / Airbnb are contract-complete stubs.
- **Ready to scale to 50+ OTAs without architecture change**: a new OTA = one
  new adapter file implementing `OTAAdapter`, registered in the core. Nothing
  else changes.
