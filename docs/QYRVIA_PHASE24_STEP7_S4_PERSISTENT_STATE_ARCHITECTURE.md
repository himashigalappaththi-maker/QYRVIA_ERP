# QYRVIA Phase 24 — Step 7 (S4): Persistent State Architecture (Design Only)

**Mode:** DESIGN ONLY. **No persistence implemented, no code modified, no migrations, no schemas
created, no UI touched.** Logical models only.

**Purpose:** design the durable layer that will replace the in-memory `channelMappingStore` (S2),
`channelSyncQueue` (S3), the (future) dead-letter queue, and sync-status tracking — **without changing
current behavior**.

**Grounded in live conventions (verified):**
- `event_store` (`db/migrations/0006_event_store.sql`): `UUID PK gen_random_uuid()`, `tenant_id UUID
  NOT NULL REFERENCES tenants(id)`, `property_id UUID REFERENCES properties(id)`, `aggregate_type/id`,
  `event_type`, **`event_version` (per-aggregate monotonic)**, `payload_json JSONB`, `occurred_at
  TIMESTAMPTZ`; indexes on `(tenant_id, occurred_at DESC)`, `(aggregate_type, aggregate_id)`,
  `(event_type, occurred_at DESC)`, GIN(payload). **RLS** `ENABLE`+`FORCE`, policy
  `tenant_id::text = current_setting('app.tenant_id', true)`, append-only (`REVOKE UPDATE, DELETE`).
- Table style (`0019_pms_reservations.sql`): UUID PKs, `tenant_id`/`property_id` FKs, RLS per table,
  per-property counters keyed `(property_id, …)`.
- Live in-memory APIs to preserve verbatim: `channelMappingStore.{linkReservation,setExternalId,
  getChannel,getExternalId,updateSyncState,getSyncState}`; `channelSyncQueue.{enqueue,dequeue,
  markProcessing,markCompleted,markFailed,get,list,size,clear}`; durability seam `eventBus.publish` →
  `insertAuditEvent` + `insertDomainEvent` (event_store), and the pure `BookingService.reducer`.

> **Design invariant:** the persistent layer is introduced **behind the existing store/queue
> interfaces**. No caller (subscriber, future adapter, future endpoint) changes. The Map and the table
> are two implementations of the same contract; a flag selects `memory | dual | db`.

---

## 1. Storage Architecture (5 logical stores)

All stores follow house convention: `UUID PK`, `tenant_id`/`property_id` FKs, per-table RLS
(`tenant_id::text = current_setting('app.tenant_id', true)`), `created_at/updated_at TIMESTAMPTZ`,
JSONB for opaque payloads. Migration numbers would be **≥ 0031** (next free), but **none are written
in this step**.

### 1.1 `booking_store`
- **Purpose:** durable canonical booking mirror (replaces `BookingService.byId` Map) — the inbound OTA
  booking + its link to a PMS reservation.
- **Ownership:** Channel Manager (write); read by status projection + inbound bridge.
- **Primary key:** `id UUID`. **Natural uniqueness:** `UNIQUE (tenant_id, channel, external_ref)`.
- **Columns (logical):** `tenant_id, property_id, channel, external_ref, status, guest_name, arrival,
  departure, room_type_id, amount, currency, pms_reservation_id (nullable FK→reservations.id),
  source_channel, version INTEGER, payload_json JSONB, created_at, updated_at`.
- **Indexes:** `UNIQUE(tenant_id, channel, external_ref)`; `(tenant_id, status)`;
  `(pms_reservation_id)`; `(tenant_id, property_id, arrival, departure)` for slot lookups.
- **Retention:** permanent (system of record for external bookings); archive CHECKED_OUT/CANCELLED >
  N months to a cold partition — never hard-deleted (audit + dispute history).

### 1.2 `channel_mapping_store`
- **Purpose:** room-type ↔ OTA room/rate mapping **and** reservation→channel/external-id links
  (replaces `reservationToChannel` + `reservationToExternalId`).
- **Ownership:** Channel Manager (write); read by subscriber, status projection, inbound resolver.
- **Primary key:** `id UUID`. Two logical roles, two uniqueness rules:
  - mapping rows: `UNIQUE (tenant_id, property_id, channel, room_type_id)`;
  - reservation-link rows: `UNIQUE (tenant_id, reservation_id, channel)`.
- **Columns:** `tenant_id, property_id, channel, enabled BOOL, credentials_ref (opaque, NOT secret),
  room_type_id, ota_room_id, ota_rate_plan_id, reservation_id (nullable), external_id (nullable),
  created_at, updated_at`.
- **Indexes:** the two UNIQUEs; `(tenant_id, property_id, channel)`; `(reservation_id)`.
- **Retention:** permanent while channel active; soft-disable via `enabled=false` (never lose mapping
  history needed to interpret old external refs).

### 1.3 `sync_queue_store`
- **Purpose:** durable outbound job queue (replaces `channelSyncQueue` Map/order/pendingKeys).
- **Ownership:** Channel Manager core / future worker.
- **Primary key:** `id UUID` (== queue item `id`). **Dedupe uniqueness:**
  `UNIQUE (tenant_id, reservation_id, action) WHERE status = 'PENDING'` (partial index — the exact S3
  rule: only PENDING dupes blocked).
- **Columns:** `tenant_id, property_id, reservation_id, action, channel, payload_json JSONB,
  status (PENDING|PROCESSING|COMPLETED|FAILED), attempts INTEGER DEFAULT 0, lease_until TIMESTAMPTZ
  NULL, next_run_at TIMESTAMPTZ, created_at, updated_at`.
- **Indexes:** partial-unique dedupe above; `(status, next_run_at)` for the worker poll;
  `(tenant_id, reservation_id)`.
- **Retention:** COMPLETED rows purged after a short window (e.g. 7–30 days) for throughput;
  PENDING/PROCESSING never purged; FAILED handed to `dead_letter_store`.

### 1.4 `dead_letter_store`
- **Purpose:** terminal-failure records + reprocess control (new — S3 had only an in-mem list concept).
- **Ownership:** Channel Manager; operator-driven reprocess.
- **Primary key:** `id UUID`. **Coalesce uniqueness:** `UNIQUE (tenant_id, reservation_id, action,
  dedupe_generation)` — one live DLQ row per failing key (poison-message coalescing).
- **Columns:** `tenant_id, property_id, reservation_id, action, channel, payload_json JSONB,
  attempts, last_error TEXT, reprocess_requested BOOL DEFAULT false, created_at, updated_at`.
- **Indexes:** the coalesce UNIQUE; `(tenant_id, reprocess_requested)`; `(channel)`.
- **Retention:** keep ≥ 90 days for forensics; archive thereafter; never auto-replay (explicit
  `reprocess_requested`).

### 1.5 `sync_state_store`
- **Purpose:** per-resource delta hash + last sync status + `last_sync_at` (replaces
  `SyncEngine._delta` + `channelMappingStore.lastSync`/`syncState`). Powers the frontend `last_sync_at`.
- **Ownership:** Channel Manager (SyncEngine + subscriber).
- **Primary key:** composite `(tenant_id, channel, resource_key)` — mirrors S3/SyncEngine resource keys.
- **Columns:** `tenant_id, property_id, channel, resource_key, reservation_id (nullable), last_hash,
  last_status, last_error, last_sync_at TIMESTAMPTZ, updated_at`.
- **Indexes:** PK; `(tenant_id, channel)`; `(reservation_id)`.
- **Retention:** one row per live resource (upserted, not appended) — naturally bounded; prune when a
  mapping is removed.

### 1.6 Convention table

| Store | PK | Critical UNIQUE (idempotency anchor) | RLS | Append/Upsert |
|---|---|---|---|---|
| booking_store | id | (tenant, channel, external_ref) | per-tenant | upsert by natural key |
| channel_mapping_store | id | (tenant, prop, channel, room_type) / (tenant, reservation, channel) | per-tenant | upsert |
| sync_queue_store | id | **partial** (tenant, reservation, action) WHERE PENDING | per-tenant | insert + status update |
| dead_letter_store | id | (tenant, reservation, action, gen) | per-tenant | insert (coalesced) |
| sync_state_store | (tenant, channel, resource_key) | = PK | per-tenant | upsert |

---

## 2. Migration Path (Map → dual-write → DB → remove in-memory authority; NO downtime)

Strangler pattern, **per store**, gated by a config flag (`CHANNEL_PERSISTENCE = memory | dual | db`,
default `memory` — exactly the `ERROR_ENVELOPE` precedent from Phase 23, so default boot is unchanged).

```
Stage 0  memory  (today)        store = Map();                 ← current behavior, untouched
   │
Stage 1  introduce repo         buildXStore() gains an optional { repo }
   │     (no flag change)       interface identical; memory still authoritative
   │
Stage 2  dual                   every mutation writes BOTH Map AND repo;
   │     reads come from MEMORY  (DB write failure logged, non-fatal) → observe parity
   │
Stage 3  db                     reads switch to repo; Map kept as warm cache/dual-write one release
   │
Stage 4  remove in-mem authority delete Map; repo is sole source; replay-on-boot (S4 §3) enabled
```

- **No downtime:** at every stage the public interface (`getSyncState`, `enqueue`, …) is identical;
  callers (subscriber, future worker) never change. A stage is a flag flip, reversible instantly.
- **Order across stores:** `channel_mapping_store` + `sync_state_store` first (read-mostly, low risk),
  then `booking_store`, then `sync_queue_store` + `dead_letter_store` (highest churn, validated last).
- **Parity gate:** promote `dual → db` only after a parity check (memory snapshot == repo snapshot)
  passes in staging — same discipline as Phase 23 R1 verification.

---

## 3. Replay Strategy (startup recovery, integrated with `event_store`)

Boot sequence (ordered; serve traffic only after step 5):

```
1. restore mappings    : load channel_mapping_store → rebuild reservation→channel/external links
2. restore sync state  : load sync_state_store → delta hashes + last_sync_at (skip-unchanged works)
3. restore queue       : load sync_queue_store WHERE status IN (PENDING, PROCESSING);
                         PROCESSING with expired lease_until → reset to PENDING (re-lease)
4. restore failed jobs : load dead_letter_store; leave inert unless reprocess_requested=true
5. reconcile bookings  : fold event_store (reservation.*/booking.*) through BookingService.reducer
                         → verify/repair booking_store (pure fold ⇒ deterministic, idempotent)
READY (open subscriber + future worker AFTER 1–5)
```

- **event_store is the spine:** because `eventBus.publish` persists the domain event **before**
  fan-out, the channel state can always be re-derived from the log even if a store write lagged. The
  reducer is already pure (proven), so replay = deterministic reconstruction, never duplication.
- **Bounded replay:** reconcile only from the last `booking_store` checkpoint (max processed
  `event_store.occurred_at`/`event_version` per aggregate), not the whole log — O(new events).

---

## 4. Failure Scenarios

| Scenario | Without persistence (today) | With S4 design — behavior & recovery |
|---|---|---|
| **Crash during queue processing** | job lost (in-mem) | job is `PROCESSING` with `lease_until`; on boot the expired lease resets to `PENDING` → retried. At-least-once + idempotency ⇒ safe. |
| **Crash before OTA acknowledgment** | unknown; possible double-send on manual retry | job stays `PROCESSING`; lease expiry re-queues; the **same** dedupe key + downstream idempotency mean a re-push is a benign repeat, not a duplicate booking. |
| **Duplicate replay** (event/job seen twice) | n/a (state volatile) | unique constraints (booking natural key, partial-unique PENDING, sync_state PK upsert) collapse duplicates; reducer fold is a no-op on repeats. |
| **Stale mapping** (OTA room remapped mid-flight) | silent mismatch | mapping rows are versioned/`updated_at`; inbound resolution uses current `enabled` mapping; unresolved → routed to DLQ (`reprocess_requested` after operator fixes mapping), never dropped. |
| **Missing PMS reservation** (inbound booking, command rejects / reservation absent) | booking lost in Map on crash | `booking_store` row persists with `pms_reservation_id = NULL` (link-pending); retried via correlation key → create-or-update, **no duplicate**; surfaced to operator. |

---

## 5. Idempotency Preservation (Step 3 model still holds)

The Step 3 three-layer idempotency maps **one-to-one** onto DB constraints — persistence *strengthens*
it (durable, not memory-scoped):

| Step 3 layer | In-memory (S2/S3) | Persistent equivalent (S4) |
|---|---|---|
| Inbound booking dedupe (`chan:ref:status`) | `BookingService` Map status compare | `booking_store UNIQUE(tenant, channel, external_ref)` + status/version column |
| Outbound queue dedupe (`resourceKey#hash` / reservation+action) | `pendingKeys` Set | `sync_queue_store` **partial UNIQUE (tenant, reservation, action) WHERE PENDING** |
| Command correlation (create-or-update) | external_ref carried in payload | `booking_store.pms_reservation_id` link + correlation in command request_id |
| Delta-skip | `SyncEngine._delta` Map | `sync_state_store(last_hash)` upsert |
| Lifecycle monotonicity (forward-only) | status-rank guard in subscriber | same guard, now reading persisted `booking_store.status`/`sync_state.last_status` |

**Delivery guarantee unchanged:** at-least-once transport + idempotent effect = **exactly-once
effect**. Persistence makes the dedupe windows durable (survive restart) instead of evaporating — the
Step 3 guarantees become *stronger*, never weaker. Lease+ack (§4) preserves at-least-once with
at-most-one net effect.

---

## 6. Validation Requirements (proofs)

| Requirement | Proof |
|---|---|
| **No behavior change required** | Stores sit behind the existing S2/S3 interfaces; flag default `memory`. Subscriber/queue callers are byte-identical. Phase 24 tests (S1–S3, 475/0) pass untouched. |
| **No PMS changes required** | Bridge stays events-in/commands-out; `booking_store.pms_reservation_id` references `reservations.id` read-only. PMS emits the same events (`reservation.*`, `room.status_changed`, `rate_plan.*`) it already does. |
| **No OTA changes required** | S4 is below the adapter; adapters (still future) consume `sync_queue_store` exactly as they would the in-mem queue. |
| **Supports multi-property** | Every store carries `tenant_id` + `property_id` with RLS `current_setting('app.tenant_id')` — identical to `event_store`/`reservations`. Mapping/queue/state are property-scoped by key. |
| **Supports Booking Engine + OTA** | `channel_mapping_store` (room/rate mapping) + `sync_queue_store` (outbound) + `booking_store` (inbound) are the exact substrate both need; `source_channel` distinguishes a Booking-Engine direct booking from an OTA one. |

---

## 7. QYRVIA Roadmap Compatibility (must not block future modules)

| Future module | How this design stays compatible |
|---|---|
| **Channel Manager** | Direct target; persistence is its missing durability layer. |
| **Booking Engine** | A first-class internal "channel" (like QYRCN); reuses `channel_mapping_store` + `sync_queue_store`; `source_channel` prevents echo-back to OTAs. |
| **OTA Integration** | Adapters read `sync_queue_store` / write `booking_store` via the unified contract (Step 2 §3.2); credentials via `credentials_ref`, never in these tables. |
| **AI WhatsApp Booking Agent** | Creates reservations through the **same** `pms.reservation.create` command → emits `reservation.created` → flows through the identical subscriber→mapping→queue path; no special-casing. JSONB payloads carry conversational metadata if needed. |
| **Revenue Forecasting Engine** | Already a read-only subscriber (`revenueSubscriber`); `sync_state_store`/`booking_store` are additional read projections; no coupling added. |
| **CRM Automation** | Consumes the durable `event_store` + `booking_store` (guest/booking history) read-only; `booking_store.guest_name`/links provide the join surface. |

**Non-blocking guarantee:** every future module integrates through the **already-public** kernel
seams (event_store, commandBus, the store interfaces) — none requires a schema change to these five
stores beyond additive columns.

---

## 8. Risk Matrix

| Risk | Likelihood | Impact | Mitigation |
|---|:---:|:---:|---|
| Dual-write divergence (Map vs DB) | MED | MED | Reads stay on memory until parity gate passes; DB-write failure non-fatal + logged; reconcile from event_store |
| Partial-unique dedupe semantics differ from Set | LOW | MED | `WHERE status='PENDING'` partial index exactly models `pendingKeys`; covered by porting S3 tests to the repo |
| Lease/at-least-once double-effect | LOW | MED | Downstream idempotency (booking natural key) makes re-push benign; OTA ack reconciliation |
| RLS/tenant scoping mistakes | LOW | HIGH | Copy the proven `event_store`/`reservations` RLS policy verbatim; per-tenant `app.tenant_id` |
| Migration regressions | LOW | MED | Strangler per store, flag-reversible, default `memory`; promote only on green parity |
| event_store replay cost at scale | LOW | LOW | Checkpoint-bounded reconcile (O(new events)), not full-log |
| Roadmap lock-in | LOW | HIGH | Additive-only schema; kernel-seam integration; JSONB escape hatch |

---

## 9. Migration Blueprint (sequenced, reversible)

```
B1  Define repo interfaces mirroring S2/S3 store/queue APIs (no DDL yet)         [design→build]
B2  Author migrations ≥0031 for the 5 stores (RLS+indexes per §1)                [build]
B3  Wire CHANNEL_PERSISTENCE flag (default 'memory')                             [build]
B4  Stage: mapping_store + sync_state_store  → dual → parity → db                [rollout]
B5  Stage: booking_store                      → dual → parity → db               [rollout]
B6  Stage: sync_queue_store + dead_letter_store → dual → parity → db             [rollout]
B7  Enable replay-on-boot (§3); switch queue drain to durable worker            [rollout]
B8  Remove in-memory authority; keep interfaces                                  [cleanup]
```
Each B-stage is independently reversible (flip flag to `memory`/`dual`). No B-stage requires PMS, OTA,
or UI change.

---

## 10. Go / No-Go Recommendation

**GO — for the design; build proceeds store-by-store behind the default-off flag.**

| Gate | Status |
|---|---|
| Behavior-preserving (default `memory`) | ✅ |
| No PMS / OTA / UI change required | ✅ |
| Idempotency model preserved (strengthened) | ✅ §5 |
| Multi-property ready (RLS + tenant/property keys) | ✅ |
| Roadmap-compatible (CM/Booking/OTA/WhatsApp/Revenue/CRM) | ✅ §7 |
| Reversible, no-downtime migration | ✅ §2, §9 |

**Recommendation:** approve S4 architecture; begin implementation at **B1–B3** (interfaces + migrations
+ flag) which are zero-behavior-change, then roll stores per §9. Hold OTA adapter work until
`sync_queue_store` reaches `db` (B6) so the first real OTA traffic lands on durable rails.

---

## 11. Constraints honored
✅ No persistence implemented · ✅ No code modified · ✅ No migrations created · ✅ No schemas created ·
✅ No UI touched. **Design + documentation only.**

## 12. Output index
1. Storage architecture (5 stores: purpose/ownership/PK/indexes/retention) — §1.
2. Migration path (Map→dual→db→remove) — §2, §9.
3. Replay strategy (event_store-integrated boot) — §3.
4. Failure scenarios — §4.
5. Idempotency preservation — §5.
6. Risk matrix — §8 · Migration blueprint — §9 · Go/No-Go — §10.
