# QYRVIA Phase 24 — Step 1: Channel Manager Architecture Audit

**Mode:** READ-ONLY architectural audit. **No code, schema, UI, endpoint, or refactor changes.**
**Goal:** factual baseline of Channel Manager (CM) readiness for OTA + Booking-Engine integration.

**Evidence base (read live):** all `server/src/channel-manager/**` (35 files), `server/src/index.js`
(wiring), `server/src/routes/api.js`, `frontend-stitch/src/modules/channel/Channel.view.js`,
`frontend-stitch/src/services/index.js`, and the `server/test/channel_*`/`ota_scale` suites.

---

## 0. Headline findings (the five that matter)

1. **Two divergent adapter taxonomies; only one is live.** The running core registers **class-based**
   adapters (`adapters/{qyrcn,bookingcom,agoda,expedia,airbnb}/*Adapter.js`) at `index.js:172-177`.
   A second **file-discovery registry** (`adapters/otas/*.adapter.js` ×8 + `registry/` + `adapterFactory`
   + `assertAdapter`) is **orphaned from the live path** — referenced only by `test/ota_scale.test.js`.
2. **PMS coupling is effectively ZERO** — and that is the central integration gap, not a strength to
   bank. CM neither reads PMS availability/reservations/rate-plans nor writes reservations.
3. **All live adapters are mocks/stubs.** No real OTA HTTP/XML client, auth, or credentials anywhere.
4. **Sync mechanics are genuinely solid** (canonical model, delta-hash skip, idempotent queue,
   exponential-backoff retry, partial-failure isolation, durable events) — but **runtime state is
   in-memory** (bookings, delta map, dead-letter) and lost on restart.
5. **Frontend exposure is minimal and clean** — one view, service-layer-only, normalize-absorbed.

---

## 1. Module Inventory

### 1.1 Live endpoints (`/api/channel`, `channel.routes.js`)

| Op | Method | Route | Permission | Envelope | Handler → Core |
|---|:---:|---|---|---|---|
| READ | GET | `/status` | `channel.mapping.read` | `{ ok, data }` (R1, Step 3) | `core.status()` |
| WRITE | POST | `/sync/rates` | `channel.sync.run` | `{ ok, result }` | `core.pushRates` → `SyncEngine.syncRate` |
| WRITE | POST | `/sync/inventory` | `channel.sync.run` | `{ ok, result }` | `core.pushInventory` → `SyncEngine.syncInventory` |
| WRITE | POST | `/bookings/sync` | `channel.sync.run` | `{ ok, result }` | `core.syncBookings` (pull + ingest) |
| WRITE | POST | `/bookings/confirm` | `channel.sync.run` | `{ ok, result }` | `core.confirmBooking` |
| WRITE | POST | `/bookings/cancel` | `channel.sync.run` | `{ ok, result }` | `core.cancelBooking` |

> 1 read, 5 writes. RBAC reuses migration-0030 permissions; `deps.channelManager` absent ⇒ router is
> a no-op (graceful). Error shape now flows through `errorField` (Phase 23 Step 4) — string by default.

### 1.2 Component map

| Layer | Files | Role | State |
|---|---|---|---|
| API | `api/channel.{routes,controller}.js` | thin HTTP → core | — |
| Orchestration | `core/ChannelManagerCore.js` | adapter registry (Map), canonical pipeline, sync delegation, event hooks | `_adapters` Map (in-mem) |
| Sync | `core/sync/{SyncEngine,QueueManager,RetryPolicy}.js` | delta sync, idempotent queue, backoff, dead-letter | `_delta` Map, `_queue`, `_seen`, `deadLetter` (all in-mem) |
| Canonical | `core/canonical/{types,CanonicalBooking,CanonicalRate,CanonicalInventory}.js` | OTA-agnostic shapes + keys | — |
| Events | `core/events/{EventTypes,events,ChannelEventBus}.js` | wraps shared `core/eventBus` → `event_store` + audit + webhook fanout | **durable** |
| Services | `services/{RateService,InventoryService,BookingService,ConflictResolver}.js` | validate→canonical; ingest + conflict; conflict policy | `BookingService.byId` Map (in-mem) |
| Adapters (LIVE) | `adapters/{qyrcn/QTCNAdapter,bookingcom/BookingComAdapter,agoda,expedia,airbnb}` | class-based, extend `OTAAdapter` | mock |
| Adapters (ORPHAN) | `adapters/otas/*.adapter.js` ×8 + `registry/*` + `adapters/base/assertAdapter.js` | filesystem-discovery registry | **not wired** |

### 1.3 Live channels (`index.js:172-177`)
`qytn/QTCN` (internal, first-class) · `booking.com` (working mock) · `agoda` · `expedia` · `airbnb`
(contract-complete stubs). The `OTAAdapter` contract = `pushRates, pushInventory, pullBookings,
confirmBooking, cancelBooking, mapToCanonical` + `channel` (`OTAAdapter.js:20`).

---

## 2. Data Flow Map

### 2.1 Outbound — rate/inventory push (caller → OTA)
```
HTTP POST /sync/rates|inventory  (caller supplies rate/inv FIELDS in body)
  → controller → core.pushRates/pushInventory
  → RateService/InventoryService.validate()  → CanonicalRate/Inventory   (NO PMS source)
  → SyncEngine: delta-hash check → skip if unchanged
       else QueueManager.enqueue(idempotencyKey = resourceKey#hash)
         → process(): adapter.pushRates/Inventory()  [MOCK: logs only]
            → SyncEngine sets delta hash → emit rate/inventory_updated event
         → on terminal failure: dead-letter + emit channel.sync_failed
```

### 2.2 Inbound — booking pull (OTA → CM, **not → PMS**)
```
HTTP POST /bookings/sync
  → core.syncBookings: adapter.pullBookings()  [MOCK returns canned raw]
  → per raw: adapter.mapToCanonical() → BookingService.ingest()
       ingest: idempotent (dedupe by id+status) → ConflictResolver on CONFIRMED slot clash
       stored in IN-MEMORY Map → emit booking_created event
  → returns summary {pulled, created, deduped, conflicts}
```

### 2.3 The mandated chain vs reality

| Required chain | Implemented? | Where it breaks |
|---|:---:|---|
| Booking (OTA) → **PMS reservation** | ❌ | `BookingService.ingest` writes a local Map; never calls reservations/commandBus. |
| PMS availability → **Channel inventory** | ❌ | `/sync/inventory` uses caller-supplied fields; `InventoryService` never reads PMS availability. |
| PMS/Revenue rate-plan → **Channel rate** | ❌ | `/sync/rates` uses caller-supplied fields; no link to revenue rate-grid. |
| Channel sync → **inventory update event** | ✅ | `inventory_updated`/`rate_updated` emitted + persisted. |
| Booking → **event log (replayable)** | ✅ | `booking_created/confirmed/cancelled` → `event_store`; `BookingService.reducer` replays. |

**The PMS↔Channel bridge does not exist.** CM is a self-contained canonical + sync engine driven by
mock adapters and explicit API inputs.

---

## 3. Integration Gaps

### 3.1 Missing OTA abstraction / real connectivity
- **All adapters are mocks** (`BookingComAdapter` logs instead of HTTP; agoda/expedia/airbnb are
  contract stubs). No REST/XML client, auth/credential handling, or rate-limit negotiation per OTA.
- **Two competing abstractions.** Live = class-based `OTAAdapter` subclasses. Orphaned = `adapters/otas`
  filesystem registry (`adapterRegistry.discover/get`, `adapterFactory`, `assertAdapter`). They define
  **different** adapter sets (orphan adds makemytrip, googletravel, tripadvisor; lacks the live QTCN
  wiring). Only the class-based set is reachable from `index.js`; the registry path is test-only
  (`ota_scale.test.js`). This duplication must be reconciled before scaling OTAs.

### 3.2 Missing webhook / event handlers
- **No inbound OTA webhook endpoint.** Bookings are **pull-only** (`/bookings/sync` → `pullBookings()`).
  Real OTAs push reservation notifications; there is no `/channel/webhook` ingress.
- Outbound events are well-handled (durable via shared bus), but **no CM subscriber writes channel
  outcomes back into PMS** (no reservation creation on `booking_created`).

### 3.3 Missing retry / failure durability (mechanics exist, persistence doesn't)
- Retry/backoff/idempotency/partial-failure isolation are implemented (`QueueManager` + `RetryPolicy`).
- **But:** `deadLetter`, the delta map, and the bookings Map are **in-memory only** — lost on restart;
  no DB-backed queue, no dead-letter reprocessing endpoint, no boot-time `event_store` replay to
  rehydrate `BookingService`. `SyncEngine` drains the queue **synchronously per request** (no
  background worker), so retries happen inside the HTTP call.

### 3.4 Missing channel mapping persistence
- `status()` reports live channels + queue/booking counts, but there is **no room-type ↔ OTA
  room/rate-plan mapping store**. The frontend looks for `mappings` / `last_sync_at` that the backend
  never produces, so the UI falls back to a raw JSON dump (`Channel.view.js:25`).

### 3.5 Unconsumed capability
- `confirmBooking` / `cancelBooking` exist end-to-end (adapter + core + route + service) but **no UI
  consumes them** (see §4).

---

## 4. Frontend Dependency Map

### 4.1 Consumers
| UI module | Services used | Notes |
|---|---|---|
| `modules/channel/Channel.view.js` | `services.channel.{status, syncRates, syncInventory, syncBookings}` | The **only** CM consumer. Sync buttons gated by `can('channel.sync.run')`. |

`services.channel.{confirmBooking, cancelBooking}` are **defined** (`services/index.js:159-160`) but
**referenced by no view** — backlog/unwired.

### 4.2 Service vs direct API
- **0 direct `fetch`** — all calls go through `apiClient` via `services.channel.*`
  (`services/index.js:154-161`). Single-ingress discipline intact.

### 4.3 Normalize / unwrap usage
- `Channel.view.js:7,18,19` uses `asObject(res)` + `asArray(...)`. With R1 (`/status` → `{ ok, data }`),
  `asObject` unwraps `data` cleanly. The view defensively also reads `mappings`/`name`/`connected`/
  `lastSyncAt` aliases that the backend doesn't emit — harmless, but confirms the §3.4 mapping gap.
- Error path uses `e.message` (R2-safe: always a string).

---

## 5. Risk Assessment

### 5.1 Coupling risk — **LOW (by absence)**
CM has almost no compile-time or runtime coupling to PMS (no imports of pms services, no commandBus
use). This makes CM independently testable and safe to evolve — **but** the same absence is the
integration gap: the PMS bridge will have to be **added**, and that new coupling must be designed
deliberately (event-subscriber pattern, not direct calls, to preserve isolation).

### 5.2 OTA readiness — **LOW–MEDIUM (3.5 / 10)**

| Dimension | Score | Evidence |
|---|:---:|---|
| Canonical model | ✅ Strong | `Canonical{Booking,Rate,Inventory}` + keys; adapters only see canonical |
| Sync engine (delta/idempotency/retry/isolation) | ✅ Strong | `SyncEngine` + `QueueManager` + `RetryPolicy` |
| Event durability | ✅ Strong | `ChannelEventBus` → `event_store` + audit + webhooks |
| Real OTA connectivity | ❌ None | all adapters mock/stub |
| PMS bridge (bookings→reservations, availability→inventory) | ❌ None | §2.3 |
| Inbound webhooks | ❌ None | pull-only |
| Mapping persistence | ❌ None | §3.4 |
| State durability | ⚠️ Weak | in-memory queue/dead-letter/bookings |
| Adapter taxonomy | ⚠️ Duplicated | live class-based vs orphan registry |

**Reading:** the *architecture* is OTA-ready; the *integration* is not. The skeleton (canonical +
sync + events) is production-shaped; everything that touches a real OTA or real PMS is mock/absent.

### 5.3 Frontend stability impact — **LOW (8.5 / 10 stable)**
Single view, service-layer-only, normalize-absorbed, R1/R2-aligned, RBAC-gated. The only fragility is
cosmetic: `status()` lacks the `mappings`/`last_sync_at` the UI prefers, so it shows a JSON fallback —
no error, no crash. Adding a mapping payload later is non-breaking (additive).

---

## 6. Test coverage (context, not a deliverable)
`channel_adapter_contract`, `channel_booking_conflict`, `channel_canonical`, `channel_event_replay`,
`channel_sync_engine`, `ota_scale` (drives the orphan registry), `platform`. All engine/core-level;
**no HTTP-envelope test** for `/api/channel` (consistent with Phase 23 Step 3 finding). Suites green.

---

## 7. Baseline conclusion (readiness for OTA + Booking Engine)

| Capability | State |
|---|---|
| Canonical + sync + event backbone | **Ready** |
| Real OTA adapters (HTTP/auth) | **Not started** (mocks only) |
| PMS ↔ Channel bridge | **Absent** (both directions) |
| Inbound OTA webhooks | **Absent** |
| Channel/room/rate mapping store | **Absent** |
| Durable queue / dead-letter / replay-on-boot | **Partial** (logic yes, persistence no) |
| Adapter registry unification | **Needed** (two taxonomies) |
| Frontend integration | **Stable, minimal** |

**Factual baseline:** Channel Manager is an architecturally sound, well-isolated **engine skeleton**
with mock edges. To reach OTA + Booking-Engine integration it needs four net-new builds — (a) real
adapter connectivity, (b) a PMS bridge via event subscribers, (c) inbound webhook ingress, and
(d) a persisted mapping + durable queue layer — plus reconciliation of the duplicate adapter registry.
None of these are started; none are blocked. This audit changed **zero** code.

## 8. Constraints honored
✅ No code changes · ✅ No schema changes · ✅ No UI changes · ✅ No endpoint creation · ✅ No refactoring.
