# QYRVIA ERP — Phase 30.1: ARI Foundation (OTA-Grade Core Engine)

**Version:** V35
**Date:** 2026-06-25
**Status:** ✅ Implemented + validated (unit + real PostgreSQL 18.4). Standalone internal engine. No OTA integration, no UI, no adapter/registry changes. Awaiting approval before the next phase.

> Phase 30.1 builds the **deterministic source of truth** for Availability, Rates, and Restrictions that every future OTA integration depends on. It is a pure internal engine: same input state → byte-identical output, multi-property isolated, concurrency-safe.

---

## A. ARI Architecture Design

```
                          ┌──────────────────────────────┐
   query (property,       │        ariService            │  orchestration (deterministic)
   channel, dates,  ─────▶│  computeAri() / quoteStay()  │
   occupancy)             └───────┬───────────┬──────────┘
                                  │           │
                 ┌────────────────┘           └─────────────────┐
                 ▼                ▼                ▼             ▼
        availabilityEngine   rateEngine v2   restrictionEngine  mapping
        (stop-sell, blocks,  (occupancy/LOS/  (CTA/CTD/MinLOS/  (RoomType↔
         overbooking guard)  DOW/seasonal/    MaxLOS/stay-      RatePlan↔
                 │            derived)         through/window)  Channel)
                 └──────────────┬─────────────────┬─────────────┘
                                ▼                  ▼
                          ruleResolver      outputContract (OTA-ready JSON)
                   (priority: system→property→rate_plan→channel)
                                │
                                ▼
                          store contract  ── memoryStore (deterministic, isolated)
                                           └─ dbStore (ari_* tables, optimistic version + atomic delta)
```

**Principles:** engines are **pure functions** over plain validated model objects (no clock, no randomness, no I/O) → determinism. Persistence is a swappable store. Multi-property isolation is enforced at the service (read-by-property) and at the DB (FORCE RLS). The output is a neutral, OTA-mappable contract — no OTA coupling lives in the engine.

**Files (`server/src/ari/`):** `model.js`, `ruleResolver.js`, `availabilityEngine.js`, `rateEngine.js`, `restrictionEngine.js`, `mapping.js`, `outputContract.js`, `ariService.js`, `index.js`, `store/memoryStore.js`, `store/dbStore.js`.

---

## B. Core Engine Modules

**Availability** — `available = stopSell ? 0 : max(0, physical + overbookingBuffer − sold − blocked)`. Configurable overbooking guard (per cell). `stayAvailability()` = the limiting (minimum) night across a half-open range.

**Rate v2** — fixed, documented pipeline → deterministic:
`base → date rule (amount replaces / pct multiplies) → LOS pricing (amount replaces / pct multiplies) → occupancy (occupancyRates[n] or base + extraAdult·(adults−standard)) → + children (first matching childRate by maxAge) → round half-up 2dp`.
Supports occupancy-based pricing, derived rates (extra adult / child), LOS pricing, day-of-week and seasonal overrides (via rate rules).

**Restriction** — resolves each field independently by precedence: **CTA, CTD, MinLOS, MaxLOS, stay-through, min/maxAdvanceDays (booking window)**. `evaluateStay()` applies them to a concrete `[arrival, departure)` and returns a deterministic `{ bookable, los, reasons[] }`.

---

## C. Data Model Schema Additions

**Migration `0049_ari_foundation.sql`** — additive, 7 tables, each with `tenant_id`/`property_id` FKs, **FORCE Row-Level Security** on `app.tenant_id`, and a `version` column for optimistic concurrency:
`ari_room_type`, `ari_rate_plan` (occupancy/derived as JSONB), `ari_inventory_grid` (date grid), `ari_rate_rule`, `ari_restriction_rule`, `ari_los_pricing`, `ari_channel_mapping`.

**Verified post-migration (on the real DB, before tests):** all 7 tables present; RLS enabled+forced on all; 1 policy each; PK + 2 FKs per table; CHECK counts (grid 4, rate_plan 4, los 1, rate/restriction rule 2, room_type 1); scope indexes on the rule tables. No partial/missing state.

---

## D. Deterministic Rule Evaluation Engine

`ruleResolver.js` resolves the effective value of any date-scoped attribute from a rule set. **Priority (low→high, higher wins): system → property → rate_plan → channel.** A rule **matches** when same property, its scope fields (`roomTypeId`/`ratePlanId`/`channel`, null = wildcard) equal the context, the date is in the half-open window, and `dow` (if set) includes the date's day-of-week. **Conflict resolution is total + explicit** (so output is deterministic): higher level rank → higher `priority` → lexically greater `id`. Restriction fields resolve **independently**, so partial rules compose predictably.

---

## E. Test Suite & Results

**Unit (`test/ari_engine.test.js`) — 12 pass / 0 fail.** Covers: model validation; availability (stop-sell, blocks, overbooking buffer, limiting-night); rate (occupancy, extra-adult, occupancy override, child pricing, seasonal-amount, pct, LOS); resolver priority (system<property<rate_plan<channel); restriction CTA/CTD/MinLOS/MaxLOS/advance window; defaults; **computeAri determinism (byte-identical output)**; quoteStay; **multi-property isolation**; channel-exposure mapping.

**DB (`test/db/ari_persistence.db.test.js`, real PostgreSQL 18.4) — 5 pass / 0 fail.** Covers: computeAri round-trip through the DB store; multi-property isolation; **RLS tenant isolation**; **concurrency — optimistic version** (exactly one stale writer wins, the other gets `conflict`); **concurrency — atomic `adjustSold`** (3 concurrent +1 increments all land, no lost update). Boundary-compliant per Phase 29 (no DDL / no CREATE ROLE / single `qyrvia_test` role / tenant-context / DELETE cleanup).

**Regression:**
| Suite | Before (Phase 29) | After (Phase 30.1) |
|---|---|---|
| Backend (`npm test`) | 642 — 636 pass / 0 fail / 6 skip | **655 — 648 pass / 0 fail / 7 skip** |
| ARI DB (real PG) | n/a | **5 pass / 0 fail** |
Pass delta = +12 (ARI unit); +1 skip (ARI DB placeholder without a URL). **Zero regressions.**

**Defect found & fixed during validation:** the DB store's `iso()` converted `DATE` columns via `toISOString()`, which **shifted the day** in the machine's non-UTC timezone (UTC+5:30) → grid lookups missed → availability 0. Root cause: node-pg returns `DATE` as a local-midnight `Date`. Fixed to format with **local date components**. Re-run: all green. (Engine logic + schema unchanged.)

---

## F. Output Contract Specification (OTA-ready JSON)

`ari_version = "1.0"`. Deterministic (no timestamps/generated ids). Shape:
```json
{
  "ari_version": "1.0",
  "property_id": "...", "channel": "BCOM|null", "currency": "LKR",
  "date_from": "2026-07-01", "date_to": "2026-07-04",
  "room_types": [{
    "room_type_id": "rt-dlx", "code": "DLX",
    "availability": [{ "date": "2026-07-01", "available": 4, "stop_sell": false }],
    "rate_plans": [{
      "rate_plan_id": "rp-bar", "code": "BAR", "currency": "LKR",
      "days": [{
        "date": "2026-07-01", "rate": 100.0,
        "restrictions": { "cta": false, "ctd": false, "min_los": 1, "max_los": null,
                          "stay_through": false, "min_advance_days": 0, "max_advance_days": null }
      }]
    }]
  }]
}
```
`quoteStay()` additionally returns `{ bookable, available, los, reasons[], currency, total, nights[] }`. A structural validator (`validateOutput`) guards the shape.

---

## G. Integration Boundary (how Channel Manager consumes ARI later)

ARI is **upstream + neutral**; the Channel Manager is **downstream + OTA-specific**. The boundary is the **store contract** (in) and the **output contract** (out):

1. **Feed (future):** a sync wires PMS room types / rate plans / reservations + inventory → the `ari_*` tables (the integration that replaces today's mocks). ARI never reads PMS directly — it computes only over its own model, preserving isolation + determinism.
2. **Consume (future):** the canonical channel layer calls `service.computeAri({ propertyId, channel, dateFrom, dateTo })`, then a **per-OTA mapper** translates the neutral contract into each OTA's ARI message format (Booking.com / Expedia / …) using `ari_channel_mapping` (room/rate codes + exposure). `quoteStay()` backs booking-time validation.
3. **No coupling now:** ARI does not import or modify the channel adapters or canonical registry (Phase 28 untouched). The mapper + feed are explicit future phases.

---

## Success Criteria — Confirmation

| Criterion | Result |
|---|---|
| Same input ⇒ identical output | ✅ asserted byte-identical (`JSON.stringify` equality) |
| Multi-property isolation | ✅ unit + DB (service read-by-property + FORCE RLS) |
| Concurrent updates handled safely | ✅ optimistic version + atomic delta, validated on real PG |
| Ready for Booking.com-style ARI mapping | ✅ neutral OTA-mappable contract + channel mapping model + boundary (§G) |

## Rules Compliance
No OTA integration, no UI, no adapter changes, no canonical-registry changes. ARI is a standalone internal engine, testable in isolation, no external dependencies. Migration is additive (no `DROP`); DB tests are data-level only. **Awaiting approval before the next phase (real transport / first OTA).**
