# QYRVIA Phase 24 — Step 2: Channel Manager Integration Architecture Design

**Mode:** DESIGN ONLY. **No code, no schema implementation, no UI, no endpoint creation.**
Logical schemas and contracts only. Builds on
[`QYRVIA_PHASE24_STEP1_CHANNEL_MANAGER_AUDIT.md`](./QYRVIA_PHASE24_STEP1_CHANNEL_MANAGER_AUDIT.md).

**Grounded in live primitives (verified, not hypothetical):**
- Event bus — `server/src/core/eventBus.js`: `subscribe(type, handler)` / `publish(event)`;
  `persistToAudit` writes `audit_events` **and** `event_store` (`insertDomainEvent`) **synchronously
  before** subscriber fan-out → events are durable and replayable.
- Subscriber template — `server/src/revenue/services/revenueSubscriber.js`
  (`on('reservation.created', …)`, `on('reservation.cancelled', …)`).
- PMS already emits: `reservation.created` (`commands/pms/index.js:416`), `reservation.updated` (`:494`),
  `reservation.room_moved` (`:526`), `reservation.checked_in/out` (`checkinFolio.js:84,145`),
  `room.status_changed` (`index.js:148,529`), `rate_plan.created` (`:337`). `reservation.cancelled`
  is already consumed by revenue.
- Inbound commands exist: `pms.reservation.create` (`:346`), `pms.reservation.update` (`:462`),
  `pms.reservation.checkin/checkout`, `pms.room.status.change`.

> **Design principle that falls straight out of the audit:** the bridge needs **no new PMS coupling**
> — PMS already publishes the exact domain events the channel layer must react to, and already exposes
> the commands the channel layer must call. The work is additive subscribers + persistence, not PMS
> surgery.

---

## 1. Final Architecture Diagram (layered, text model)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXTERNAL                Booking.com │ Expedia │ Agoda │ Airbnb │ QYRCN(internal)│
└───────────────▲───────────────────────────────────────────────▲──────────────┘
                │ webhook push (inbound)            outbound HTTP │ (rates/inv/res)
┌───────────────┴───────────────────────────────────────────────┴──────────────┐
│ ADAPTER LAYER  (ONE unified contract: OTAAdapter v2)                           │
│   normalizeBooking · pushReservation · pushAvailability · pushRateUpdate       │
│   handleWebhook        + lifecycle(init/health/close) + AuthStrategy (abstract) │
└───────────────▲───────────────────────────────────────────────▲──────────────┘
                │ canonical in                       canonical out│
┌───────────────┴───────────────────────────────────────────────┴──────────────┐
│ CHANNEL CORE   ChannelManagerCore · SyncEngine(delta) · QueueManager(durable)  │
│                ConflictResolver · ChannelEventBus(wraps core/eventBus)          │
│   ┌──────────────── PERSISTENT STATE LAYER (new) ────────────────────────────┐ │
│   │ booking_store · sync_queue_store · dead_letter_store ·                    │ │
│   │ channel_mapping_store · sync_state_store        (+ replay-on-boot)        │ │
│   └───────────────────────────────────────────────────────────────────────────┘ │
└───────────────▲───────────────────────────────────────────────▲──────────────┘
   inbound: dispatch│ commandBus                  subscribe │outbound: PMS events
┌───────────────┴───────────────────────────────────────────────┴──────────────┐
│ INTEGRATION BRIDGE  (new, event-only — NO direct PMS imports)                  │
│   channelInboundService  → commandBus.dispatch('pms.reservation.create'|...)   │
│   channelSubscriber      ← eventBus.subscribe('reservation.*','room.status_*', │
│                                               'rate_plan.*')                     │
└───────────────▲───────────────────────────────────────────────▲──────────────┘
                │ commands                                events │
┌───────────────┴───────────────────────────────────────────────┴──────────────┐
│ SHARED KERNEL   core/eventBus (publish→audit_events+event_store→fanout)         │
│                 core/commandBus · core/queryBus                                  │
└───────────────▲───────────────────────────────────────────────────────────────┘
                │ emits reservation.*/room.*/rate_plan.* + serves projections
┌───────────────┴───────────────────────────────────────────────────────────────┐
│ PMS DOMAIN   reservations · rooms · rate plans · availability · folios          │
│   (UNCHANGED — already an event producer + command surface)                     │
└───────────────────────────────────────────────────────────────────────────────┘
                                          │ read projection
┌─────────────────────────────────────────┴─────────────────────────────────────┐
│ FRONTEND   Channel.view.js → services.channel.* → GET /status (channel_status_view)│
└────────────────────────────────────────────────────────────────────────────────┘
```

**Hard boundary rule:** the Integration Bridge is the *only* layer that knows both worlds, and it
touches PMS **exclusively** through `eventBus` (in) and `commandBus` (out). No channel file imports a
`services/pms/*` module. This preserves the LOW coupling the audit measured while *adding* the bridge.

---

## 2. Component Breakdown (NEW systems only)

| # | Component | Type | Responsibility | Replaces / fixes |
|---|---|---|---|---|
| C1 | **`channelSubscriber`** | bridge (outbound) | Subscribes to PMS domain events; enqueues outbound sync jobs (availability/rate/reservation push) per mapped channel. Mirrors `revenueSubscriber`. | "disconnected PMS integration" (outbound) |
| C2 | **`channelInboundService`** | bridge (inbound) | Receives canonical bookings from adapters/webhooks; idempotently dispatches `pms.reservation.create/update/cancel` via `commandBus`. | "inbound bookings never reach PMS" |
| C3 | **OTAAdapter v2 contract** | adapter standard | Single canonical interface (§4) unifying the two taxonomies into one. | "dual adapter systems" |
| C4 | **`AuthStrategy` (abstract)** | adapter support | Pluggable per-OTA credential/token model behind the adapter; no secrets in core. | "no auth strategy" |
| C5 | **`booking_store`** | persistence | Durable canonical bookings + status; source of truth replacing the in-mem Map. | "in-memory booking state" |
| C6 | **`sync_queue_store`** | persistence | Durable job queue (enqueue/lease/ack) backing `QueueManager`. | "in-memory queue" |
| C7 | **`dead_letter_store`** | persistence | Durable terminal-failure records + reprocess marker. | "dead-letter lost on restart" |
| C8 | **`channel_mapping_store`** | persistence | Room-type ↔ OTA room/rate-plan mapping + per-channel enable/credentials-ref. | "no mapping persistence" + frontend `mappings` gap |
| C9 | **`sync_state_store`** | persistence | Per-resource delta hash + `last_sync_at` + last status. | "delta map lost on restart"; powers `last_sync_at` |
| C10 | **`channel_status_view`** | read projection | Read model assembled from C8+C9 for `GET /status` (mappings, last_sync_at, status). | frontend JSON-fallback (§5 audit) |
| C11 | **Replay-on-boot loader** | recovery | On start, rehydrate live state from `event_store` (bookings) + stores (queue/delta) before serving. | "no crash recovery" |

> Everything above is **additive**. PMS, commandBus, queryBus, eventBus, and the canonical model are
> reused as-is.

---

## 3. Core architecture requirements

### 3.1 PMS ↔ Channel Integration Bridge (event-only)

**Producers (PMS → bus) — reuse what already exists:**

| Brief's required producer | Live event today | Action |
|---|---|---|
| `reservation.created` | ✅ `reservation.created` | subscribe |
| `reservation.updated` | ✅ `reservation.updated` | subscribe |
| `reservation.cancelled` | ✅ (consumed by revenue) | subscribe |
| `room.status.changed` | ✅ `room.status_changed` | subscribe (→ availability recompute) |
| `rate.plan.updated` | ⚠️ only `rate_plan.created` today | **design note:** PMS to also emit `rate_plan.updated` on rate change; until then subscribe to `rate_plan.created` + a future update event. *(No PMS change in this step — flagged for the build phase.)* |

**Consumers (C1 `channelSubscriber`) — one handler per concern:**

| Handler | Trigger event(s) | Effect (enqueue, never call OTA inline) |
|---|---|---|
| availability sync handler | `room.status_changed`, `reservation.created/updated/cancelled` | recompute availability for affected room-type/date → enqueue `pushAvailability` per mapped channel |
| reservation sync handler | `reservation.created/updated` | enqueue `pushReservation` to channels that own/mirror the reservation |
| cancellation handler | `reservation.cancelled` | enqueue cancellation push + reconcile `booking_store` |
| rate push handler | `rate_plan.created`/`updated` | enqueue `pushRateUpdate` per mapped channel |

**Inbound (C2 `channelInboundService`):** canonical booking → look up `channel_mapping_store` →
`commandBus.dispatch('pms.reservation.create', mappedInput, ctx)` (or `.update`/cancel). The command
already emits `reservation.created`, which the outbound side ignores for the originating channel
(loop-prevention via `source_channel` tag, §3.4).

**Coupling guarantee:** bridge ↔ PMS = events in + commands out, both already-public kernel APIs. Zero
new direct dependency; either side is independently testable with a fake bus/commandBus.

### 3.2 Unified OTA Adapter Standard (OTAAdapter v2)

Collapse the live class-based contract and the orphaned `adapters/otas` registry into **one**:

```
interface OTAAdapter {
  channel: string                          // canonical CHANNELS id
  // data plane (canonical in/out)
  normalizeBooking(rawWebhookOrPull): CanonicalBooking
  pushReservation(canonicalBooking): Promise<Ack>
  pushAvailability(canonicalInventory): Promise<Ack>
  pushRateUpdate(canonicalRate): Promise<Ack>
  handleWebhook(httpReq): { events: CanonicalBooking[], verified: boolean }
  // lifecycle
  init(config): Promise<void>              // wire AuthStrategy, validate creds
  health(): Promise<{ ok, detail }>
  close(): Promise<void>
}
```

- **Lifecycle model:** `registered → init() → healthy ⇄ degraded → closed`. Registry instantiates,
  `init()` binds credentials via `AuthStrategy`, `health()` gates whether the SyncEngine routes jobs to
  it (degraded ⇒ jobs park in `sync_queue_store`, not lost).
- **Authentication strategy (abstract only):** `AuthStrategy` interface — `getAuthHeaders()`,
  `refresh()`, `isValid()`. Concrete forms (API-key, OAuth2 client-credentials, signed-HMAC) are per
  adapter; **core never sees secrets** — only a `credentials_ref` from `channel_mapping_store`
  resolved through the platform secret provider.
- **Failure isolation rules:** one adapter's `init()`/`health()`/push failure must never (a) block
  other channels' jobs, (b) crash the SyncEngine, or (c) lose a job. Failures → retry (C6) → backoff →
  `dead_letter_store` (C7), scoped strictly to that `channel`. The existing `QueueManager` partial-
  failure isolation is the model; it gains durability.
- **Migration of taxonomy:** keep the class-based `OTAAdapter` location as the home; retire the
  `adapters/otas/*` + `registry/` discovery path (move its useful filesystem-discovery idea into the
  v2 registry if wanted). One contract, one registry, one source of truth.

### 3.3 Persistent State Layer (logical schemas only)

> Logical models for design review — **not** DDL, no migration written here.

**`booking_store`** — durable canonical bookings (replaces `BookingService.byId`)
`{ booking_id (pk), channel, external_ref, status, guest_name, arrival, departure, room_type_id, amount, currency, pms_reservation_id?, version, source_channel, created_at, updated_at }`

**`sync_queue_store`** — durable jobs (replaces `QueueManager._queue/_seen`)
`{ job_id (pk), channel, op (push_rate|push_inv|push_res|cancel), idempotency_key (uniq), payload, state (pending|leased|done|failed), attempts, lease_until, next_run_at, created_at }`

**`dead_letter_store`** — terminal failures (replaces in-mem `deadLetter`)
`{ dlq_id (pk), channel, op, idempotency_key, payload, attempts, last_error, reprocess_requested (bool), created_at }`

**`channel_mapping_store`** — the missing mapping registry (also powers frontend)
`{ mapping_id (pk), tenant_id, property_id, channel, enabled, credentials_ref, room_type_id, ota_room_id, ota_rate_plan_id, created_at, updated_at }`

**`sync_state_store`** — delta + status (replaces `SyncEngine._delta`; powers `last_sync_at`)
`{ tenant_id, property_id, channel, resource_key, last_hash, last_sync_at, last_status, last_error }` (pk = resource_key+channel)

**Idempotency strategy (three layers):**
1. **Inbound:** `external_ref + status` dedupe in `booking_store` (today's Map dedupe, persisted).
2. **Queue:** `idempotency_key = resourceKey#hash` UNIQUE in `sync_queue_store` (today's `_seen`, persisted).
3. **Command:** inbound dispatch carries the channel `external_ref` so a re-delivered webhook maps to
   the same reservation (update, not duplicate-create).

**Replay-on-boot (C11) & crash recovery:**
- On start: (1) rebuild `booking_store` consistency by folding `event_store` `booking.*`/`reservation.*`
  through `BookingService.reducer` (already exists, pure); (2) requeue `sync_queue_store` rows in
  `pending|leased(expired)` state; (3) reload `sync_state_store` deltas.
- Crash mid-job: jobs use **lease + ack** — a `leased` job whose `lease_until` elapsed is reclaimed and
  retried (at-least-once). Because pushes are idempotent (layer 2), at-least-once is safe.
- Because `eventBus.publish` persists to `event_store` **before** fan-out, no domain event is lost even
  if the channel subscriber dies mid-handling; on reboot the subscriber re-derives from the log.

### 3.4 End-to-End Data Flow (see §4 lifecycles for detail)
Loop-prevention: every booking/reservation carries `source_channel`. The outbound reservation handler
**skips** channels equal to `source_channel`, so an OTA booking ingested into PMS does not bounce back
to the originating OTA.

### 3.5 Frontend Contract Alignment (backward compatible)

The audit found `Channel.view.js` already *reads* `mappings`, `last_sync_at`, `status` but the backend
never emits them (JSON fallback). The new **`channel_status_view`** projection makes those real:

```
channel_status_view (GET /status payload, { ok, data } per R1):
{
  channels:[ { channel, enabled, internal, commissionPct, status,           // from mapping_store
               last_sync_at, last_status } ],                               // from sync_state_store
  mappings:[ { channel, room_type_id, ota_room_id, ota_rate_plan_id } ],    // from mapping_store
  queue:{ size, deadLetter },                                              // from queue/dlq stores
  bookings:{ count }                                                        // from booking_store
}
```

- **No breaking change:** the view already tolerates absence of these keys (renders fallback today).
  Populating them is purely additive — existing fields (`channels`, `queue`, `bookings`) keep their
  shape; the UI upgrades from JSON-dump to the table it was already coded for (`Channel.view.js:20-24`).
- **`mapping_registry` (logical only):** = `channel_mapping_store` projected read-only; no new endpoint
  — served through the existing `GET /status` envelope.

---

## 4. Full Data Flow Specification

### 4.1 Inbound booking lifecycle (OTA → PMS)
```
1. OTA webhook → POST (existing /api/channel surface; handleWebhook on the adapter)
2. adapter.handleWebhook(req): verify signature → normalizeBooking() → CanonicalBooking[]
3. channelInboundService:
     a. booking_store upsert (idempotent by external_ref+status) → dedupe replays
     b. resolve channel_mapping_store (ota_room → room_type_id)
     c. commandBus.dispatch('pms.reservation.create'|'update'|cancel, mapped, ctx)
4. commandBus → PMS creates reservation → emits reservation.created (→ event_store, durable)
5. booking_store.pms_reservation_id = result.id  (link established)
6. ChannelEventBus emits channel.booking_ingested (audit/observability)
```
Failure at step 3c (command rejects): record in `dead_letter_store` with the command error; **no PMS
partial state** (commandBus is transactional per its contract).

### 4.2 Outbound sync lifecycle (PMS → OTA)
```
1. PMS emits reservation.*/room.status_changed/rate_plan.* (already happens)
2. channelSubscriber handler fires (per §3.1), computes affected resource(s)
3. For each mapped+enabled channel (skip source_channel):
     SyncEngine.delta check vs sync_state_store.last_hash → skip if unchanged
     else sync_queue_store.enqueue(op, idempotency_key=resourceKey#hash, payload)
4. Worker leases job → adapter.pushAvailability|pushRateUpdate|pushReservation()
5. success → sync_state_store.update(last_hash,last_sync_at,last_status=OK)
            → ChannelEventBus emit inventory_updated|rate_updated|reservation_pushed
   failure → §4.3
```
Note: the worker is now a **background drain** of `sync_queue_store` (not the audit's synchronous
per-request drain), decoupling OTA latency from the PMS transaction.

### 4.3 Failure + retry lifecycle
```
adapter push throws
  → QueueManager: attempts++ ; RetryPolicy.shouldRetry? 
      yes → schedule next_run_at = now + backoff(attempts) ; state=pending (lease released)
      no  → dead_letter_store.insert(last_error) ; sync_state_store.last_status=FAILED
            ; ChannelEventBus emit channel.sync_failed (durable)
operator/reprocess: dead_letter_store.reprocess_requested=true
  → requeued into sync_queue_store with a fresh idempotency window
adapter health=degraded → jobs stay pending (parked), not dead-lettered → auto-resume on health=ok
```
Data-loss safety: a job is removed from `pending` only after `done` ack; a crash between push and ack
re-leases and retries (idempotent ⇒ safe). Events are in `event_store` before any of this.

---

## 5. Migration Strategy

### 5.1 Mock → real adapter transition (per channel, behind health-gating)
1. Land OTAAdapter v2 contract + adapter shells **wrapping today's mocks** (no behavior change).
2. Implement real `AuthStrategy` + HTTP client **inside one adapter** (Booking.com first — it is the
   "working mock" already). Keep mock as a fallback `source` for tests.
3. Gate go-live with `health()` + `channel_mapping_store.enabled` per property; a channel flips from
   mock to real by config, not redeploy.
4. Repeat Expedia → Agoda → Airbnb; QYRCN (internal) stays first-class.

### 5.2 In-memory → persistent state transition (strangler, dual-write)
1. Introduce stores (C5–C9) **alongside** the in-mem structures; write to both (dual-write), read from
   memory. No behavior change, observable parity.
2. Flip reads to the stores once parity is verified; keep dual-write one release.
3. Remove the in-mem structures; enable replay-on-boot (C11). Now crash-safe.
4. Switch the queue drain from synchronous (per request) to the background worker leasing
   `sync_queue_store`.

### 5.3 Safe rollout order (dependency-correct)
```
S1 OTAAdapter v2 contract + registry unification        (no runtime change; retire orphan path)
S2 channel_mapping_store + channel_status_view          (frontend upgrades JSON-dump → table; additive)
S3 booking_store + sync_state_store (dual-write)         (persistence parity)
S4 sync_queue_store + dead_letter_store + worker         (durable retry; background drain)
S5 channelSubscriber (outbound bridge)                   (PMS events → enqueue; loop-prevention on)
S6 channelInboundService (inbound bridge)                (webhook → commandBus → PMS reservation)
S7 replay-on-boot + crash-recovery                       (close durability gap)
S8 real adapters per channel (5.1)                       (eliminate mocks last, when all else is safe)
```
Rationale: build the **safety net (persistence + bridge) before** turning on real OTA traffic, so the
first real booking lands in a crash-safe, idempotent, PMS-connected pipeline.

---

## 6. Risk Assessment

| Risk | Level | Driver | Mitigation in this design |
|---|:---:|---|---|
| **OTA integration risk** | **MED-HIGH** | Real protocols/auth/rate-limits per OTA; today 100% mock | One v2 contract + per-adapter `AuthStrategy`; health-gating; per-channel phased go-live (5.1); failure isolation scoped per channel |
| **Data-loss risk** | **HIGH → LOW** (post-design) | Today bookings/queue/dead-letter are in-mem (audit §3.3) | Durable stores C5–C9; `event_store`-first publish; lease+ack at-least-once; replay-on-boot; 3-layer idempotency |
| **PMS coupling risk** | **LOW** | Bridge could tempt direct PMS calls | Hard rule: events-in/commands-out only; no `services/pms/*` import; bridge mirrors `revenueSubscriber` (proven pattern) |
| **Frontend stability risk** | **LOW** | `/status` payload shape change | Purely additive (`channel_status_view`); view already tolerates missing keys; existing fields unchanged; R1 `{ok,data}` preserved |
| **Loop / double-booking risk** | **MED → LOW** | OTA booking could echo back out | `source_channel` tag; outbound handler skips origin; command-level idempotency by `external_ref` |
| **Migration risk** | **LOW-MED** | Swapping live state layer | Strangler dual-write with parity gates (5.2); stores land before bridge before real adapters (5.3) |

---

## 7. Goal check & constraints

| Goal | Addressed by |
|---|---|
| Fix PMS disconnection | §3.1 bridge (C1/C2) over existing events/commands |
| Eliminate mock adapters | §3.2 v2 contract + §5.1 per-channel real transition |
| Persistence + replay safety | §3.3 stores C5–C9 + C11 replay-on-boot |
| Booking Engine + OTA readiness | unified adapter, durable pipeline, mapping store, webhook ingress |

**Constraints honored:** ✅ no code changes · ✅ no schema implementation (logical models only) ·
✅ no UI changes · ✅ no endpoint creation · ✅ design only.

## 8. Output index
1. Final architecture diagram — §1.
2. Component breakdown (new systems only) — §2.
3. Full data flow spec (inbound / outbound / failure) — §4.
4. Migration strategy (mock→real, in-mem→persistent, rollout order) — §5.
5. Risk assessment (OTA / data-loss / PMS coupling / frontend) — §6.
