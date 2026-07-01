# QYRVIA ERP — Phase 30.2: Real OTA Transport & Reconciliation Foundation

**Version:** V35
**Date:** 2026-06-25
**Status:** ✅ Implemented + validated (unit + real PostgreSQL 18.4). Additive, standalone, backward-compatible. No live OTA calls, no certification claims. Awaiting approval before Phase 31.

> Replaces the generic HTTP stub identified in the Phase 30 audit with a **production-grade OTA transport architecture**: real per-OTA codecs, auth/retry/ack/rate-limit abstractions, Booking.com + Expedia providers, a reconciliation engine, sync monitoring, and PostgreSQL persistence with FORCE RLS. The HTTP transport is **injected + default-disabled**, so the logic is real and deterministically testable without any live network call.

---

## Audit (pre-implementation, verified)

The existing canonical adapter (`adapters/framework/TransportOTAAdapter.js`) already exposes the right seams — an injected `transport` plus `mapRate/mapAvailability/mapReservation` codec hooks and an `AuthStrategy` (`credentials_ref`, never a raw secret). The Phase 30 gap was that the codecs were identity and `transport/transport.js` did a generic JSON `POST` with no ack/error mapping, retry, or rate limiting. Phase 30.2 is therefore **additive**: a new `channel-manager/ota/` layer with real codecs + transport orchestration, **without modifying** the canonical registry, adapters, Booking Engine, Reservations, PMS, Revenue, or ARI.

---

## Design

```
   ARI/operation ─▶ OtaTransport(provider) ─▶ rate-limit gate ─▶ auth headers (AuthStrategy)
                                              ─▶ provider.encode (codec)
                                              ─▶ http.send  (INJECTED, default DISABLED)
                                              ─▶ provider.decodeAck  ──▶ normalized Acknowledgement
                                              ─▶ retry on RETRYABLE (RetryPolicy backoff)
   reconcile(local, remote) ─▶ drift report + recovery recommendations
   syncMonitor ─▶ metrics + health (healthy→degraded→down) + DLQ visibility
   store (memory | db: ota_sync_attempt / ota_drift / ota_transport_health, FORCE RLS)
```

**Files (`server/src/channel-manager/ota/`):** `transport.js`, `providers/{_shared,bookingcom,expedia,index}.js`, `reconciliation.js`, `monitoring.js`, `store/{memoryStore,dbStore}.js`, `index.js`. Migration `0050_ota_transport.sql`.

---

## A. OTA Transport Abstraction

`buildOtaTransport({ provider, http, auth, retryPolicy, rateLimiter })` — one delivery = **rate-limit gate → resolve auth headers → codec encode → http send → codec decode → normalized ack → retry on retryable**. Pieces:
- **Acknowledgement** (`normalizeAck`): `{ ok, ackId, status, retryable, errors[], raw }` — the single shape every provider decodes into.
- **Auth**: reuses `CredentialAuthStrategy` (secret resolved on-demand via `SecretProvider`, never stored/logged).
- **Retry**: shared `RetryPolicy` (exp backoff) + provider retry classification.
- **Rate limit**: per-channel min-interval limiter (injectable clock/sleep).
- **HTTP**: injected; **default `buildDisabledHttp()` → `transport_disabled`** (no network).

## B. Booking.com Transport

Real codec (`providers/bookingcom.js`): maps the neutral ARI update onto Booking.com's ARI message (`hotel_id`, `ari[].{room_id, rate_plan_id, rate.{amount,currency}, restrictions.{closed_to_arrival, closed_to_departure, min/max_length_of_stay}}`); availability + reservation-ack codecs; **auth boundary** (`X-Booking-Api-Key` / Basic); **error mapping** (parses `body.errors`, falls back to `http_<status>`); **retry mapping** (429/5xx/network → retry; 4xx → permanent).

## C. Expedia Transport

Same architecture (`providers/expedia.js`), Expedia (EQC-style) shape (`resort_id`, `roomTypes[].ratePlans[].schedule[].{rate, cta, ctd, minStay, maxStay}`), **Bearer** auth, Expedia error mapping (`Errors[]`/`errors[]`). Adding a provider = one file (registry in `providers/index.js`).

## D. Reconciliation Engine

`reconcile({ channel, local, remote })` — pure + deterministic. Detects **inventory / rate / reservation** drift, each classified `missing_remote | missing_local | value_mismatch`, and emits **recovery recommendations** (`push_inventory`, `resync_inventory`, `ingest_reservation`, `resolve_reservation_status`, …). Deterministic key ordering → reproducible reports.

## E. Sync Monitoring

`buildSyncMonitor({ store })` — records every attempt; aggregates **metrics** (total/ok/failed/retries, retry-rate, success-rate, per-op); **transport health** escalation (consecutive failures: `healthy → degraded → down`); **DLQ visibility** (per-channel dead-letter counts). Write-through to the store for durable visibility.

## F. Persistence & Security

Migration `0050_ota_transport.sql` (additive): `ota_sync_attempt` (with a **partial-unique `(tenant_id, idempotency_key)`** → idempotent processing), `ota_drift`, `ota_transport_health`. **FORCE RLS** + `app.tenant_id` policy on all three (binds the non-superuser owner). DB store does idempotent insert (`ON CONFLICT … DO NOTHING`), drift persistence, and health upsert (retains `last_ok_at`).

---

## Validation & Results

Staged DB validation (migrate → **schema verified** → tests), per the established process:
- Migration `0050` applied, exit 0. Schema verify: 3 tables, **RLS enabled+forced**, constraint counts correct (drift 2 checks/2 fk, attempt 2 checks/2 fk, health 1 check/1 fk), idempotency partial-unique index present.

| Suite | Result |
|---|---|
| OTA unit (`test/ota_transport.test.js`) | **11 pass / 0 fail** — codecs (BCom+Expedia), ack classification, default-disabled, retry-then-success, no-retry-401, auth headers, rate limiter, reconciliation (deterministic), monitoring escalation, registry |
| OTA DB (`test/db/ota_transport.db.test.js`, real PG 18.4) | **6 pass / 0 fail** — idempotent recording, status CHECK, metrics aggregation, drift persistence, health upsert, RLS isolation |
| All 5 boundary-compliant DB suites together (real PG) | **30 pass / 0 fail** |
| Backend regression (`npm test`) | **667 — 659 pass / 0 fail / 8 skip** (was 655 — 648/0/7 → **+12, zero regressions**) |

**Honest finding (pre-existing, not Phase 30.2):** running the *entire* `test/db/**` glob shows **25 failures** — all in the **3 legacy suites** (`finance_flows`, `rls`, `schema_and_constraints`) which still call the harness `freshSchema()` (`DROP SCHEMA`) + `setupAppRole()` (`CREATE ROLE`) and assume a superuser. Under the non-superuser `qyrvia_test` boundary they fail, and their `DROP SCHEMA` also corrupts the shared schema for adjacent suites. This is the **same test-design-bug class flagged in Phase 29**, untouched here. The Phase 30.2 additions and all boundary-compliant suites pass (30/30) when the legacy suites are excluded. **Recommendation:** port those 3 suites to the data-level boundary (test-only rework) so `test:db` can run wholesale; no product change.

---

## Rules Compliance

No mock-only implementations (real codecs/auth/retry/ack/error-mapping; only the HTTP wire is injected + disabled). No UI. **No OTA certification claims.** No adapter shortcuts. Additive migration only (no `DROP`). Backward compatibility preserved: the canonical registry, adapters, Booking Engine, Reservations, PMS, Revenue, and ARI are **unmodified** — the OTA layer is standalone and composed later. **Awaiting approval before Phase 31 (first certified OTA integration).**
