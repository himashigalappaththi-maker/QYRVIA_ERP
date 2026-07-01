# QYRVIA Phase 24 — Step 3: Channel Manager Consistency, Idempotency & Conflict Resolution Model

**Mode:** DESIGN ONLY. **No code, no schema creation, no UI, no implementation.**
Builds on Step 1 (audit) and Step 2 (integration architecture). Defines the deterministic correctness
layer for OTA ↔ PMS synchronization under concurrency, retries, and conflicting updates.

**Grounded in live primitives (verified):**
- Event shape — `core/event.js` `makeEvent`: `{ event_id(uuid), event_type, aggregate_type,
  aggregate_id, tenant_id, property_id, actor_id, request_id, payload, occurred_at(ISO) }`.
  **There is no per-event monotonic version field** — ordering authority is the append-only
  `event_store` plus the `aggregateStore` optimistic `version` / `version_conflict`
  (`core/aggregateStore.js`).
- Durability — `core/eventBus.js`: `publish()` writes `audit_events` + `event_store` **synchronously
  before** subscriber fan-out; a subscriber throwing does **not** roll back the persisted event.
- Slot-conflict policy — `channel-manager/services/ConflictResolver.js`: (1) same `bookingId` =
  idempotent update; (2) CONFIRMED beats PENDING; (3) tie → incumbent (first-come), **channel-agnostic**
  (no OTA favoritism). `slotKey = propertyId|roomTypeId|arrival|departure`.
- Reducer — `BookingService.reducer` is a pure fold (applying an event twice is a no-op).

---

## 1. Formal Consistency Model Definition

### 1.1 Core correctness assumptions
1. **PMS is the system of record for reservation *lifecycle state*** (CONFIRMED→CHECKED_IN→
   CHECKED_OUT, and cancellation authority once internal). The channel layer never owns lifecycle.
2. **OTA is the source of truth for *external booking existence and guest intent*** (a Booking.com
   booking exists because Booking.com says so). CM ingests that intent into PMS; it does not invent it.
3. **Channel Manager is a relay + projection, never an authority.** It holds a canonical mirror
   (`booking_store`), sync state (`sync_state_store`), and mappings — but resolves nothing it isn't
   told to by the two authorities above.
4. **All transport is at-least-once.** The bus fan-out, the durable queue (lease+ack), and OTA webhook
   redelivery can each deliver a message more than once. Correctness therefore depends on
   **idempotent effects**, not exactly-once delivery (§4.1).

### 1.2 Ordering guarantees (by scope)

| Scope | Ordering | Mechanism | Out-of-order handling |
|---|---|---|---|
| **Per `reservation_id` (aggregate)** | **Strict (linearizable)** | `event_store` append order + `aggregateStore` optimistic `version`; a stale write gets `version_conflict` and retries against fresh state | Status-rank monotonicity guard (§1.3) rejects regressions |
| **Per OTA channel** | **Best-effort / causal** | OTAs do **not** guarantee delivery order; we derive causal order from `(status_rank, occurred_at, external_ref)` | Lower-or-equal `status_rank` than stored ⇒ treated as duplicate/stale, ignored (unless legitimate cancel) |
| **Per `room_id`** | **Best-effort, serialized at the slot** | `slotKey` contention is resolved deterministically by `ConflictResolver`, not by arrival order | Concurrent slot claims → deterministic winner (CONFIRMED>PENDING, then incumbent) |
| **Across aggregates / channels** | **No global order** | Independent aggregates; eventual consistency | N/A — each aggregate is independently linearizable |

### 1.3 Lifecycle state machine + status-rank (the out-of-order detector)
```
rank:  PENDING(1) → CONFIRMED(2) → CHECKED_IN(3) → CHECKED_OUT(4)
                 ↘ CANCELLED(terminal, allowed from PENDING|CONFIRMED only)
```
- **Forward-only rule:** an inbound event whose `status_rank ≤ stored_rank` is a stale/duplicate and is
  **ignored** (idempotent no-op) — this is how an out-of-order late `PENDING` after `CONFIRMED` is
  detected and dropped.
- **CANCELLED** is terminal but special-cased: a cancel is accepted from `PENDING`/`CONFIRMED`; a cancel
  arriving after `CHECKED_IN` is **rejected to an exception queue** (you cannot cancel a guest who has
  physically arrived — §5, conflict matrix).
- **Delivery guarantee:** at-least-once + this monotonicity guard ⇒ **exactly-once *effect*** per
  lifecycle transition.

---

## 2. Idempotency Specification

### 2.1 Key structure (three independent layers)

| Layer | Idempotency key | Stored in | Purpose |
|---|---|---|---|
| **OTA booking ingestion** | `chan:<channel>:ref:<external_ref>:st:<status_rank>` | `booking_store` (unique) | A re-delivered webhook for the same booking+status is a no-op; a new status advances state |
| **PMS reservation command** | `cmd:<channel>:<external_ref>` carried as `request_id`/correlation | commandBus / `booking_store.pms_reservation_id` | First delivery → `pms.reservation.create`; subsequent → resolves to existing `pms_reservation_id` ⇒ `pms.reservation.update`, never a duplicate create |
| **Outbound sync queue** | `<resourceKey>#<contentHash>` (existing `SyncEngine`/`QueueManager` scheme) | `sync_queue_store` (unique) | Identical rate/inventory push is deduped; only deltas enqueue |

> Keys are **content- and status-aware**, not just id-based: the same booking at a *new* status yields a
> *new* ingestion key (so progress is captured) while a *repeat* at the same status collides (so
> duplicates are dropped).

### 2.2 Deduplication windows
- **Ingestion / command keys: unbounded (durable) dedupe.** The `booking_store` row is the permanent
  record; dedupe is by persistent uniqueness, not a TTL — a webhook redelivered hours later still maps
  to the same booking. (No silent expiry ⇒ no late-duplicate booking.)
- **Outbound queue keys: per-resource current-value window.** A key is "live" until its job reaches
  `done`; once the delta hash in `sync_state_store` advances, the old key is naturally retired. A repeat
  of the *current* hash is deduped; a new value is a new key.
- **Webhook signature/nonce: short replay window** (adapter-level, e.g. minutes) to reject malicious
  replays *before* canonicalization — separate from business dedupe above.

### 2.3 Replay safety rules
1. Every effect is expressed through a key in §2.1 ⇒ replaying any event/job re-collides and no-ops.
2. `BookingService.reducer` is a pure fold (proven: applying an event twice is a no-op) ⇒ `event_store`
   replay is safe by construction.
3. PMS commands are guarded by the correlation key + lifecycle monotonicity ⇒ replayed inbound never
   double-creates.
4. The `event_store`-first publish ordering means a crash during fan-out leaves the event persisted;
   on reboot the subscriber re-derives — replay, not loss.

### 2.4 Retry / duplicate handling behavior
- **Queue retry:** `lease + ack`. A job is removed only on `done` ack; a crash between push and ack
  re-leases the same `idempotency_key` ⇒ retried push collides downstream (or is a benign repeat) ⇒
  no double-effect.
- **Webhook retry by OTA:** same `external_ref+status` ⇒ ingestion key collision ⇒ no-op.
- **Bus duplicate fan-out:** subscriber handlers are written to be idempotent (enqueue is keyed; reducer
  is pure) ⇒ duplicate delivery is absorbed.

---

## 3. Conflict Resolution Matrix

### 3.1 Source-of-truth hierarchy (the deterministic spine)
```
Reservation LIFECYCLE STATE        : PMS        > OTA > CM
External booking EXISTENCE/INTENT  : OTA        > CM  (PMS reflects it)
Agreed RATE of an existing booking : the BOOKING (locked at creation) — immune to later rate_plan changes
Availability / future inventory    : PMS        (derived) → pushed to OTA; OTA never authoritative
CM canonical mirror / sync state   : never authoritative (relay only)
```

### 3.2 Tie-break order (applied in sequence)
1. **Lifecycle precedence** — higher `status_rank` / physical-presence wins (CHECKED_IN > CONFIRMED > PENDING).
2. **Authority** — for the contested field, the source-of-truth owner (§3.1) wins.
3. **Event-version** — within one aggregate, higher `aggregateStore.version` / later `event_store`
   sequence wins (primary).
4. **Timestamp (`occurred_at`)** — tiebreaker **only**; cross-OTA clocks are untrusted, so never primary.
5. **Incumbent (first-come)** — final deterministic tie-break (matches `ConflictResolver` rule 3).

### 3.3 Matrix

| # | Scenario | Winner | Reason |
|---|---|---|---|
| 1 | Same `bookingId`/`external_ref` re-ingested, same status | Incumbent (no-op) | Idempotent update (`ConflictResolver` rule 1) |
| 2 | Two channels claim same slot; one CONFIRMED, one PENDING | CONFIRMED | `confirmed_beats_pending`, channel-agnostic |
| 3 | Two channels claim same slot; both CONFIRMED | Incumbent (first-come) | `incumbent_retained`; no OTA favoritism; loser → exception/overbooking record |
| 4 | **Cancellation (OTA) vs check-in (PMS)** | **PMS check-in** | Physical presence > remote intent; lifecycle rank CHECKED_IN(3) > cancel-from-CONFIRMED; OTA cancel → exception queue for manual handling |
| 5 | Cancellation vs CONFIRMED (not yet checked-in) | Cancellation | Terminal intent wins before presence; release slot, push availability |
| 6 | **Update vs delete/cancel** (same aggregate) | Cancel (terminal) — unless update has strictly higher `version` AND is an explicit reinstate | Terminal state dominates stale updates; version guards a legitimate later reinstate |
| 7 | **Rate change vs existing booking** | Booking keeps its locked rate; rate change applies **forward-only** | Different aggregates (`rate_plan` vs `reservation`); agreed rate immutable post-create — **not a true conflict** |
| 8 | Late `PENDING` after `CONFIRMED` (out-of-order OTA) | Stored CONFIRMED | Status-rank regression rejected (§1.3) |
| 9 | PMS update vs concurrent PMS update (same reservation) | Higher `version` | `aggregateStore` optimistic concurrency; loser gets `version_conflict` → retry on fresh state |
| 10 | OTA modify after PMS checkout | Stored CHECKED_OUT | Terminal lifecycle; OTA change → exception queue, no state mutation |

### 3.4 Override conditions
- **Only** a manual operator action (audited) may override rows 3/4/6/10 — e.g. force-cancel a
  checked-in stay (no-show correction). Implemented as an operator-initiated command carrying an
  explicit `force` + reason, fully logged to `audit_events`. No automatic rule ever overrides PMS
  physical-presence state.

---

## 4. Replay & Recovery Model

### 4.1 Formal delivery guarantees
| Channel | Guarantee | Exactly-once *effect* via |
|---|---|---|
| Event bus fan-out | **at-least-once** | pure reducer + keyed handlers |
| Outbound sync queue | **at-least-once** (lease+ack) | `idempotency_key` uniqueness in `sync_queue_store` |
| OTA webhook ingress | **at-least-once** (OTA redelivers) | ingestion key `chan:ref:status` |
| PMS command dispatch | **at-least-once** | correlation key → create-or-update |

**System-level guarantee: exactly-once *effect*, never exactly-once *delivery*.** This is the only
honest guarantee for a multi-party distributed system and is sufficient given §2 idempotency.

### 4.2 Step-by-step recovery flow (system restart)
```
BOOT
 1. Load mappings (channel_mapping_store) — needed to interpret external refs.
 2. Rehydrate bookings: fold event_store (reservation.*/booking.*) through BookingService.reducer
    → reconstruct booking_store consistency. (Pure fold ⇒ deterministic, duplication-safe.)
 3. Reload sync_state_store deltas (last_hash, last_sync_at) — so unchanged resources are skipped.
 4. Requeue: scan sync_queue_store for state IN (pending, leased-with-expired-lease) → re-lease.
 5. Dead-letter: leave dead_letter_store untouched (manual/auto reprocess is explicit, §4.4).
 6. Open inbound (webhooks) and outbound (subscriber) ONLY after 1–4 complete → no event handled
    against half-built state.
READY
```

### 4.3 Replay ordering constraints
- Replay **per aggregate in `event_store` sequence order** (append order). The reducer requires only
  intra-aggregate order, which `event_store` preserves.
- Cross-aggregate replay order is irrelevant (independent aggregates).
- Replays are bounded by the monotonicity guard (§1.3): re-applying an already-surpassed status is a
  no-op, so partial replays converge to the same state as full replays.

### 4.4 Queue reprocessing & dead-letter recovery
- **Queue reprocessing:** expired-lease jobs are reclaimed and retried under the same key (idempotent).
- **Dead-letter recovery:** a terminal job sits in `dead_letter_store` with `last_error`. Recovery is
  explicit: `reprocess_requested = true` → re-enqueued into `sync_queue_store` with a fresh attempt
  counter but the **same** `idempotency_key`, so a previously-half-applied effect cannot double-apply.
- **Poison-message safety:** repeated dead-letters of the same key are coalesced (one DLQ row per key),
  preventing retry storms (§5).

---

## 5. Failure Handling Table

| Failure type | Expected system behavior | Recovery mechanism | State correction |
|---|---|---|---|
| **Partial OTA sync failure** (some channels push OK, one fails) | Failure isolated to the failing channel; other channels commit; failing job retried then dead-lettered | `QueueManager` partial-failure isolation + per-channel retry/backoff | `sync_state_store.last_status=FAILED` for that channel only; DLQ holds payload; reprocess re-pushes |
| **PMS command failure AFTER OTA ingestion** (booking in `booking_store`, `pms.reservation.create` rejects) | No PMS partial state (commandBus is transactional); booking flagged `pms_link_pending` | Inbound retry with backoff; on terminal failure → exception queue with command error | Booking remains in `booking_store` un-linked; operator/retry reconciles; **no duplicate** because correlation key maps any retry to update-or-create |
| **Adapter timeout / retry storm** | Bounded retries with exponential backoff; circuit broken via `health()=degraded` ⇒ jobs **park** (pending), not spin | `RetryPolicy` backoff + DLQ coalescing + health-gating (Step 2 §3.2) | Parked jobs auto-resume when `health()=ok`; no unbounded retry; no data loss |
| **Inconsistent mapping state** (OTA room not mapped / mapping changed mid-flight) | Inbound: cannot resolve `room_type_id` ⇒ booking ingested but routed to exception queue (not dropped). Outbound: unmapped channel skipped | Mapping resolution failure is a first-class outcome, never a silent drop | Booking retained in `booking_store`; operator completes mapping → reprocess from exception queue links it to PMS |
| **Duplicate webhook delivery** | No-op | ingestion key collision | none needed |
| **Crash between push and ack** | Job re-leased and retried | lease expiry reclaim | idempotent push ⇒ at-most-one net effect |
| **Out-of-order OTA events** | Stale/regressive event ignored | status-rank monotonicity guard (§1.3) | none — state already correct |
| **Slot double-claim (overbooking)** | Deterministic winner; loser recorded | `ConflictResolver` + exception/overbooking record | Loser surfaced to operator; never silently overwritten |

---

## 6. Goal check & constraints

| Goal | Guaranteed by |
|---|---|
| No duplicate bookings | §2 three-layer idempotency + correlation-key create-or-update + monotonicity guard |
| No lost OTA events | `event_store`-first publish + at-least-once + exception-queue-not-drop on mapping failure |
| Deterministic conflict resolution | §3 source-of-truth hierarchy + fixed tie-break order + explicit matrix |
| Safe replay under crashes | §4 pure-reducer rehydration + per-aggregate ordered replay + lease/ack |
| Stable PMS ↔ OTA synchronization | lifecycle state machine + forward-only rule + health-gated isolation |

**Constraints honored:** ✅ no code changes · ✅ no schema creation (logical references only) ·
✅ no UI changes · ✅ no implementation · ✅ design only.

## 7. Output index
1. Formal consistency model (ordering / delivery / assumptions) — §1.
2. Idempotency specification (keys / dedupe / retry) — §2.
3. Conflict resolution matrix — §3.3 (+ hierarchy §3.1, tie-break §3.2).
4. Replay & recovery model (step-by-step) — §4.
5. Failure handling table — §5.
