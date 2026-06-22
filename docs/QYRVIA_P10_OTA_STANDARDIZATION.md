# QYRVIA Phase 10 — OTA Standardization (FINAL, authoritative)

This rule supersedes the Phase 10.1 "QTCN routing/brain layer" design.

## The rule

- All integrations are **OTAs** inside the Channel Manager: Booking.com, Agoda,
  Expedia, Airbnb, Google Travel, TripAdvisor, MakeMyTrip, **QTCN**, and future
  providers.
- The **Channel Manager is the only execution layer**. It never makes business
  decisions — it only executes adapter calls.
- **No routing engine, decision engine, or "brain layer" exists anywhere** in
  the architecture.
- **One OTA = one adapter file.** Adding an OTA requires only a new adapter file
  — no changes to Channel Manager core, sync engine, registry, factory, or DB.
- All OTAs are equal plugin adapters. **No OTA has priority; none may bypass the
  Channel Manager.**

## OTA contract (unchanged)

Each OTA implements the same interface (Phase 10.2 base, `adapters/base/assertAdapter.js`):
`pullAvailability()`, `pushRates()`, `pushInventory()`, `createBooking()`,
`cancelBooking()` — all async, normalized returns, no direct DB access.

## QTCN final state

- QTCN exists **only** as an OTA adapter (`adapters/otas/qytn.adapter.js`, and
  the Channel Manager adapter `adapters/qyrcn/QTCNAdapter.js`).
- It implements the standard contract and behaves **exactly like Booking.com**.
- **No routing, no scoring, no decision-making, no privilege, no bypass.**
- Commercial model only: **commission = 15%** (revenue = bookings + ads +
  commission tracking).

## What changed in this correction

| Action | Detail |
|---|---|
| **Removed** the brain layer | Deleted `server/src/qytn/**` (qytnEngine, routingRules, priorityMatrix, riskScorer, decision model, bridges) and its tests (`qytn_routing.test.js`, `qytn_scenario.test.js`) + doc (`QYRVIA_P10_1_QTCN.md`). Confirmed isolated: no `src/` module imported it (only its own tests). |
| **De-privileged QTCN** (`qyrcn/QTCNAdapter.js`) | Removed `internal` flag and in-process special path; now mirrors `BookingComAdapter`; commission 15%. |
| **De-privileged QTCN** (`otas/qytn.adapter.js`) | Commission 0% → 15%. |
| **Removed channel priority** (`services/ConflictResolver.js`) | Deleted the `qtcn_priority` branch; resolution is now channel-agnostic (same-booking update → confirmed-beats-pending → incumbent retained). |
| **Adjusted tests** | `channel_adapter_contract` (QTCN = 15%, no `internal`), `channel_booking_conflict` (no QTCN priority), `ota_scale` (QTCN commission 15%). |

## Preserved (not touched)

Channel Manager core, sync engine (`core/sync/*`), registry + factory
(`registry/*`), the OTA adapter system, the canonical model, the event bridge
into the DB event store, and the database schema (migrations stay 0001–0044).

## Acceptance criteria — status

- ✅ Booking.com flow == QTCN flow (identical method surface + result shapes;
  commission both 15%).
- ✅ No QTCN references in any decision/routing layer (the layer no longer exists).
- ✅ No DB schema changes; OTA contract unchanged; JS/CommonJS only.
- ✅ "Add an OTA = drop one adapter file" still holds; 50+ scaling unchanged.
- ✅ CI green (Node 22 + Postgres 16).
