# QYRVIA ERP — Phase 30: Channel Manager Commercial-Readiness Audit

**Version:** V35
**Date:** 2026-06-25
**Type:** Audit only — no code changed, no implementation. Verified against actual source.
**Benchmark:** Mews, Cloudbeds, Oracle Hospitality (OPERA Cloud / OHIP).

> **Bottom line (brutally honest):** QYRVIA's Channel Manager is an **excellent architectural skeleton with zero real OTA connectivity**. Every adapter is a mock/stub; the "real" HTTP transport is a generic JSON `POST`. You **cannot connect to a single live OTA today**, which means QYRVIA is **not commercially sellable as a channel manager** against Mews/Cloudbeds/Oracle. The plumbing is genuinely strong (registry, queue/DLQ, RLS, encryption, idempotency — much of it validated on real PostgreSQL in Phase 29); the revenue-generating surface (live two-way OTA sync) does not exist.

---

## A. Current-State Architecture Assessment

**What is genuinely built and tested (verified):**
- **Canonical adapter framework + registry** (`adapters/framework/*`, `core/ChannelManagerCore.js`) — one canonical 8-method contract, validation at registration, legacy bridge. Migrated + flag-gated in Phase 28.
- **Sync engine + durable queue** — delta-aware push (`core/sync/SyncEngine.js`, `sync/channelSyncService.js`), idempotent FIFO queue with retry + DLQ (`core/sync/QueueManager.js`, `persistence/dbStores.js`), lease worker (`worker/*`). Concurrency (`SKIP LOCKED`), idempotency, retry, DLQ, replay **validated on real PostgreSQL 18.4** in Phase 29.
- **Inbound webhook pipeline** — HMAC-SHA256 verification (`inbound/webhookVerifier.js`), idempotency + **monotonic status state machine** (`inbound/channelInboundService.js`, ranks PENDING<CONFIRMED<CHECKED_IN<CHECKED_OUT, CANCELLED terminal), routed to PMS via the command bus. Validated on real PG.
- **Credential security** — **AES-256-GCM** authenticated encryption (`credentials/cryptoBox.js`), `SecretProvider` indirection (adapters hold a `credentials_ref`, never a secret). This is production-grade.
- **Mapping management** — versioned + append-only history + audit (`mapping/channelMappingService.js`).
- **Conflict resolution** — deterministic, channel-agnostic (`services/ConflictResolver.js`).
- **Multi-property / multi-tenant** — `tenant_id`/`property_id` scoping with `FORCE` RLS, validated Phase 29.

**What "real sync" actually is (verified):** for a channel flagged "real," `channelSyncService` calls the adapter's `pushRateUpdate/pushAvailability/pushReservation`, which (for a `TransportOTAAdapter`) calls `transport/transport.js` → `buildHttpTransport`, which performs a **generic `fetch(endpoint, { method:'POST', body: JSON.stringify(payload) })`** and returns only `{ ok, status }`. There is **no OTA message format, no acknowledgement parsing, no error-code mapping, no protocol**. Default is OFF (`CHANNEL_HTTP_ENABLED=false`).

**Architecture grade:** strong (clean DI, event-driven, safe-by-default, well-tested). **Commercial-integration grade:** near-zero.

---

## B. Gap Analysis Table

| # | Evaluation Area | Verified State | Evidence | Gap |
|---|---|---|---|---|
| 1 | **Booking.com readiness** | **Mock only** | `adapters/bookingcom/BookingComAdapter.js` logs; `adapters/otas/booking.com.adapter.js` is a 10-line empty stub | No Connectivity/Content API, no auth, no ARI/reservation messages, no certification |
| 2 | **Expedia readiness** | **Mock/stub** | `adapters/expedia/ExpediaAdapter.js` | No EQC/Rapid integration, no auth, no messages |
| 3 | **Agoda readiness** | **Mock/stub** | `adapters/agoda/AgodaAdapter.js` | No YCS integration |
| 4 | **Airbnb readiness** | **Mock/stub** | `adapters/airbnb/AirbnbAdapter.js` | No Airbnb API (distinct unit/calendar model) |
| 5 | **Hotelbeds readiness** | **Does not exist** | no file; grep = 0 hits | Entire bedbank model (static + booking API) missing |
| 6 | **Webhook ingestion** | **Real (generic)** | `inbound/webhookVerifier.js`, `channelInboundService.js` | HMAC + idempotency + monotonic status work, but **no per-OTA signature schemes / timestamp-replay window / push-vs-pull per OTA** |
| 7 | **Reservation sync** | **Framework real, OTA mock** | `channelInboundService.ingest`, `channelSyncService.pushReservation` | Inbound→PMS solid; **no real OTA delivery**, no OTA modify/cancel semantics mapping |
| 8 | **Inventory sync** | **Framework real, OTA mock** | `CanonicalInventory.js`, `channelSyncService.pushAvailability` | Delta sync works; delivery is the generic stub; **no full-refresh/reconciliation** |
| 9 | **Rate sync** | **Framework real, model thin** | `CanonicalRate.js` (amount+currency only) | **No occupancy pricing, no derived/linked rates, no LOS/day-of-week pricing** |
| 10 | **Restrictions** | **Partial** | `CanonicalInventory.js`: `stopSell`, `minLos`, `maxLos` only | **CTA & CTD missing entirely** (required by Booking.com/Expedia) |
| 11 | **Mapping management** | **Real (backend)** | `mapping/channelMappingService.js` (version + history + audit) | Room-type + rate-plan-id + property mapping present; **no rate-plan entity mapping, no derived mapping** |
| 12 | **Room/rate-plan mapping UI** | **Absent (status only)** | `frontend-stitch/.../channel/Channel.view.js` = read-only status + 3 sync buttons | **No mapping editor, no onboarding wizard, no credential setup, no test-connection** |
| 13 | **Credential mgmt & security** | **Strong** | `credentials/cryptoBox.js` (AES-256-GCM), `SecretProvider` | Solid; **no key rotation workflow, no per-OTA credential schema/validation, no connection test** |
| 14 | **Retry/DLQ/reconciliation** | **Retry+DLQ real; reconciliation absent** | `QueueManager`, `dbStores` (DLQ + `reprocess_requested`); grep "reconcil" = 0 | **No reconciliation/drift-detection/full-resync engine** (critical OTA need) |
| 15 | **Conflict resolution** | **Real (basic)** | `services/ConflictResolver.js` | CONFIRMED>PENDING + incumbent; **no overbooking buffer, no last-room-availability, no per-channel priority config** |
| 16 | **Multi-property support** | **Real** | RLS (Phase 29), `tenant_id/property_id` | Tenant-grain RLS; property isolation app-level (by design). Adequate |
| 17 | **Monitoring & observability** | **Basic** | `api/controlSnapshot.js`, platform layer (Phase 18) | Status snapshot only; **no sync-failure metrics, no alerting, no per-channel health SLA, no reconciliation dashboard** |
| 18 | **OTA certification** | **Absent** | none | **No sandbox integration, no cert test harness, no provider compliance** — OTAs will not enable production without this |
| 19 | **Failure recovery & replay** | **Partial** | DLQ `requestReprocess`, event replay (Phase 29) | Replay primitive exists; **no automated recovery, no reconciliation-driven repair, no replay UI** |
| 20 | **Commercial deployment readiness** | **Not ready** | composite | See §F |

---

## C. Readiness Score

**Overall commercial OTA readiness: ~28 / 100.**

| Dimension | Weight | Score | Notes |
|---|---|---|---|
| Architecture & infrastructure | 20% | 80 | Registry, queue/DLQ, RLS, encryption, idempotency — strong, partly PG-validated |
| Real OTA connectivity | 30% | **5** | Zero live integrations; generic HTTP stub only |
| ARI completeness (rates/inv/restrictions) | 15% | 35 | MinLOS/MaxLOS/stopSell yes; **CTA/CTD, occupancy/derived pricing no** |
| Reconciliation & data integrity | 10% | 10 | DLQ/replay yes; reconciliation engine absent |
| Mapping/onboarding UX | 10% | 10 | Status-only UI; no mapping/credential workflow |
| Monitoring/alerting/SLA | 10% | 25 | Snapshot only; no alerting/metrics |
| Certification & compliance | 5% | 0 | None |
| **Weighted total** | 100% | **≈28** | |

Mews/Cloudbeds/Oracle sit at effectively 90–100 on connectivity, ARI completeness, reconciliation, and certification for dozens to 100+ certified channels. **QYRVIA's gap to them on the commercial surface is near-total**, despite a comparable-quality core architecture.

---

## D. Priority-Ranked Implementation Roadmap

1. **Canonical ARI completion** — add **CTA/CTD**, occupancy-based + derived/linked rates, LOS/day-of-week, rate-plan entity mapping. *(Blocks every real OTA.)*
2. **Real transport layer per OTA** — replace the generic `POST` with per-OTA clients: message format (XML/JSON), auth (OAuth2/API-key/basic), ARI batching, **ack + error-code mapping**, per-OTA rate limits + retry.
3. **Reconciliation engine** — scheduled full-refresh + drift detection (PMS vs OTA), auto-repair, overbooking protection.
4. **First certified OTA: Booking.com** — Connectivity + Content APIs, reservations + modify/cancel, **pass certification in sandbox**.
5. **Mapping/onboarding UI + ops console** — mapping editor, credential wizard, test-connection, DLQ reprocess, reconciliation + sync-health dashboards, alerting.
6. **Expedia, then Agoda** — EQC/Rapid, YCS; reuse the transport/ARI framework.
7. **Airbnb + Hotelbeds** — distinct models (unit/calendar; bedbank static+booking).
8. **Monitoring/SLA hardening** — metrics, alerting, per-channel health, runbooks for commercial launch.

---

## E. Recommended Phase Sequence

- **Phase 30.1 — ARI & Restriction Foundation:** CTA/CTD, occupancy/derived/LOS/DOW pricing, rate-plan mapping; extend `CanonicalRate`/`CanonicalInventory` + mapping + sync hashing + DB. *(No external network; fully testable on real PG.)*
- **Phase 30.2 — Real Transport & Reconciliation:** per-OTA transport abstraction (auth, message codecs, ack/error mapping, rate limits), reconciliation/drift engine, overbooking protection. Still vendor-agnostic + sandbox-mockable.
- **Phase 31 — Booking.com (first certified channel):** full Connectivity/Content + reservation lifecycle, certification in sandbox, go-live runbook.
- **Phase 32 — Channel Ops UI + Expedia/Agoda:** mapping/onboarding/credential/test-connection UI + ops console; Expedia (EQC/Rapid) + Agoda (YCS) on the proven framework.
- **Phase 33 — Airbnb + Hotelbeds + Commercial Hardening:** distinct models, monitoring/alerting/SLA, certification completion, multi-channel scale tests → commercial-launch gate.

---

## F. Risks That Would Prevent Selling QYRVIA Today

1. **No live OTA connection exists.** A channel manager that cannot push ARI to or receive bookings from a real OTA has no product value. **Disqualifying.**
2. **No CTA/CTD / occupancy / derived rates.** Cannot represent standard hotel rate plans + restrictions OTAs require → mappings would be rejected or mis-sell.
3. **No reconciliation.** Silent drift between PMS and OTA → **overbookings and rate errors** → direct financial + reputational liability; a hard objection from any serious hotelier.
4. **No certification.** Booking.com/Expedia/etc. **will not enable a production connection** until you pass their certification; none is started.
5. **No mapping/onboarding/ops UI.** Channels cannot be self-configured; no test-connection, no failure visibility → not operable by hotel staff or support.
6. **No monitoring/alerting on sync failures.** Production sync failures would be invisible → SLA-breaking.
7. **Hotelbeds (bedbank) entirely absent** — a different commercial model competitors offer.

**Honest competitive read:** today QYRVIA cannot win a deal where the buyer asks "which OTAs are certified and live?" — the answer is "none." The architecture means you can get there fast, but **as of now it demos as a mock**, not a sellable channel manager.

---

## G. Exact Modules / Files Requiring Work

**Extend (ARI & restrictions — Phase 30.1):**
- `server/src/channel-manager/core/canonical/CanonicalInventory.js` (+CTA/CTD)
- `server/src/channel-manager/core/canonical/CanonicalRate.js` (occupancy/derived/LOS/DOW)
- `server/src/channel-manager/core/sync/SyncEngine.js` + `sync/channelSyncService.js` (hashing incl. new fields)
- `server/src/channel-manager/mapping/channelMappingService.js` (rate-plan entity mapping)
- `server/src/db/migrations/00xx_*` (new migration — additive; channel mapping/rate-plan + restriction columns)

**Build new (Phase 30.2):**
- `server/src/channel-manager/transport/transport.js` → real per-OTA transport (auth, codecs, ack/error mapping, rate limits)
- New: `server/src/channel-manager/reconciliation/*` (drift detection + repair + overbooking guard)
- `server/src/channel-manager/services/ConflictResolver.js` (overbooking buffer, last-room-availability)

**Replace mocks with real adapters (Phases 31–33):**
- `server/src/channel-manager/adapters/bookingcom/BookingComAdapter.js` (real Connectivity/Content)
- `server/src/channel-manager/adapters/expedia/ExpediaAdapter.js`, `agoda/AgodaAdapter.js`, `airbnb/AirbnbAdapter.js`
- New: `server/src/channel-manager/adapters/hotelbeds/*`
- Retire the empty `server/src/channel-manager/adapters/otas/*.adapter.js` stub family (already deprecated in Phase 28)

**Ops & UI (Phase 32):**
- `frontend-stitch/src/modules/channel/Channel.view.js` → mapping editor + onboarding/credential wizard + test-connection
- New: channel ops console (DLQ reprocess, reconciliation + sync-health dashboards) over `api/controlSnapshot.js`
- `server/src/channel-manager/api/channel.controller.js` + `channel.routes.js` (mapping CRUD, test-connection, reconcile, DLQ reprocess endpoints)

**Certification & monitoring (Phase 33):**
- New: per-OTA certification test harness (sandbox)
- Monitoring/alerting over the platform observability layer (Phase 18)

---

## Rules Compliance

Audit only. **No code modified, nothing implemented.** All "verified" rows cite a specific file; all "gap"/"absent" rows were confirmed by reading the code and by `grep` returning no implementation (e.g. `reconcil`, `Hotelbeds`, `CTA/CTD`, OTA protocol markers). No capability was assumed. **Awaiting your direction on the Phase 30.x sequence before any implementation.**
