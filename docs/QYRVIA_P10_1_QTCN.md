# QYRVIA Phase 10.1 — QTCN Core (Revenue Routing Engine)

> **QTCN = QYRVIA Transaction & Channel Network.** It is the *brain layer*
> above the Channel Manager: a **stateless revenue-routing decision engine**
> that decides *where a booking should be fulfilled*. The Channel Manager
> (Phase 10.0) remains the execution layer.

## What QTCN is — and is not

- **Not** a booking engine. It does not create reservations or fold money.
- **Is** a routing + execution-decision layer between the PMS (source of truth),
  the Channel Manager (distribution), and OTA adapters (external demand).
- Decides: **DIRECT** (QTCN zero-commission path) vs **OTA** (which channel),
  optimizing for commission cost, inventory-mismatch probability, cancellation
  risk, and direct-vs-OTA priority.

## Architecture rule (strict, enforced by design)

QTCN is a **pure function + rules engine**:
- **No DB writes, no API calls, no I/O** inside the engine.
- Does **not** import or mutate Channel Manager internals.
- Input = `{ request, snapshot }`. Output = a routing decision.
- The engine (`core/qytnEngine.js`) imports only its own pure modules
  (`priorityMatrix`, `riskScorer`, `routingRules`, `models/qytnDecision`) — no
  `db`, no `core/eventBus`, no `channel-manager`. Verified by code review +
  tests that run with zero environment/DB.

## Folder structure (`server/src/qytn/`, new — Channel Manager untouched)

```
core/
  qytnEngine.js      pure decide({request, snapshot}) -> decision
  routingRules.js    deterministic MVP rule chain
  priorityMatrix.js  channel universe + economics (config)
  riskScorer.js      cancellation + inventory-mismatch scorers (pure)
integrations/
  channelManagerBridge.js   read-only seam to CM + pure decision->target mapping
  pmsBridge.js              read-only inventory snapshot builder
models/
  qytnDecision.js    validated decision factory
```

## Decision output model

```
{
  decisionId,                         // uuid (injectable for tests)
  route: "DIRECT" | "OTA",
  selectedChannel: "QTCN" | "booking.com" | "agoda" | ...,
  confidenceScore,                    // 0..1
  reasoning: [ ... ],                 // human-readable rule trace
  fallbackChain: [ ... ]              // ordered alternative channels
}
```

## MVP routing rules (deterministic, first match wins)

1. `directRequest` → **DIRECT / QTCN** (confidence 1.0).
2. no OTA available, **or** cheapest available OTA commission **> 18%** →
   **DIRECT / QTCN** (protect margin).
3. inventory-mismatch risk **> 0.5** → **DIRECT / QTCN** (fallback).
4. cancellation risk **> 0.6** → **OTA with the strictest cancellation policy**.
5. otherwise → **lowest-cost OTA**.

Risk scoring (`riskScorer.js`, all 0..1): cancellation risk from guest history +
refundability + lead time; inventory-mismatch from `|pmsCount − otaCount| /
pmsCount` per channel.

## OTA expansion — plug-and-play (50+ OTA ready)

- **QTCN consideration set** is config in `priorityMatrix.js`. Default channels:
  Booking.com, Agoda, Expedia, Airbnb, MakeMyTrip, Google Travel, TripAdvisor,
  and QTCN (internal direct). Adding an OTA to routing = **one entry** here.
- **Channel Manager execution** for a new OTA = **one new adapter file**
  implementing `OTAAdapter` (Phase 10.0 already guarantees this). No core,
  matrix-engine, or sync-engine change.
- `channelManagerBridge.plan(decision)` maps a routed channel to a CM channel
  and flags `executable:false` when the chosen OTA has no CM adapter yet —
  making the "needs 1 new file" boundary explicit.

## Integration rules (honored)

- QTCN never modifies Channel Manager internals; it reads only via
  `channelManagerBridge` (`availableChannels()`, `status()`, pure `plan()`).
- Inventory is read **read-only** via `pmsBridge.inventorySnapshot(...)`.
- No DB schema changes; the migration chain stays at 0001–0044.
- Phase 10.0 CI tests are untouched and still pass.

## Deliverables status

- ✅ QTCN core (engine + routing + priority matrix + risk scorer).
- ✅ Decision model with validation.
- ✅ Read-only PMS + Channel Manager bridges.
- ✅ Integration test: DIRECT vs OTA decision (`test/qytn_routing.test.js`).
- ✅ Mock scenario: Booking.com vs QTCN comparison (`test/qytn_scenario.test.js`).
- ✅ JavaScript / CommonJS only; passes existing CI (Node 22 + Postgres 16).

## Goal achieved

QTCN is the brain layer above the Channel Manager; the Channel Manager remains
the execution layer; OTA expansion is plug-and-play.
