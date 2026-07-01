# QYRVIA — Architecture State Audit & Recommended Next Phase

**Mode:** AUDIT ONLY. **No code, schema, API, UI changes. No commits.** A factual snapshot of the
as-built system and a recommendation for the next implementation phase.

**Evidence:** live module scan (`server/src/**`), feature-flag inventory (`config/env.js`), migrations
0045–0048, and the phase reports under `docs/`. Backend suite: **569 pass / 0 fail / 3 skip (572)**.

---

## 1. As-built layer map (verified)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ENTRY (revenue gate)   Booking Engine v1  (Direct / OTA / AI / Front Desk) │  NEW
│   createBooking/update/cancel → availability → pricing → validator → cmd   │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ commandBus.dispatch (no direct PMS dep)
┌───────────────┴──────────────────────────────────────────────────────────┐
│ CHANNEL MANAGER (OTA)                                                      │
│  adapters/framework  (canonical 8-method contract, registry, AuthStrategy) │  unified (B8-A)
│  transport (in-process + HTTP-disabled)  · sync (delta + per-channel real) │  B8-B3/B8-B5
│  inbound (webhook verify → idempotent booking_store → commandBus)          │  B8-B4
│  credentials (encrypted store + SecretProvider)  · mapping (versioned+hist)│  B8-B1/B8-B2
│  persistence (booking/queue/dlq/mapping/sync_state; memory|dual|db)        │  B1-B5
│  worker (lease/retry/backoff/DLQ; mock processor)                          │  B6
│  [legacy] core/ChannelManagerCore + registry/otas (DEPRECATED, still live) │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ events in / commands out (kernel seams only)
┌───────────────┴──────────────────────────────────────────────────────────┐
│ KERNEL   eventBus (event_store-first publish) · commandBus · queryBus       │  unchanged
└───────────────▲──────────────────────────────────────────────────────────┘
                │ emits reservation.*/room.*/rate_plan.*; serves projections
┌───────────────┴──────────────────────────────────────────────────────────┐
│ PMS / FINANCE / REVENUE / PLATFORM   (event producer + command surface)     │  unchanged
└───────────────▲──────────────────────────────────────────────────────────┘
                │ /api/* (contract: READ {ok,data}, WRITE {ok,result}, ERROR dual-capable)
┌───────────────┴──────────────────────────────────────────────────────────┐
│ FRONTEND (frontend-stitch SPA)   apiClient (dual-error) · normalize · views │  P23-aligned
└────────────────────────────────────────────────────────────────────────────┘
```

## 2. Capability inventory

| Domain | State | Evidence |
|---|---|---|
| API contract (envelope) | **Converged** | P23: reads `{ok,data}`, writes `{ok,result}`, error dual-shape (string default + nested capable) |
| PMS / Finance / Revenue / Platform | **Stable** | unchanged through P24; event producers + command surface |
| Channel canonical model + sync engine | **Production-shaped** | canonical types, delta, idempotent queue, durable events |
| OTA adapter framework | **Unified (B8-A)** | one 8-method contract + registry; legacy `otas`/`registry` deprecated, not removed |
| Persistence (5 stores) | **Built, flag-gated** | migrations 0045–0048; `CHANNEL_PERSISTENCE=memory` default |
| Durable worker | **Built, OFF** | lease/retry/backoff/DLQ; `CHANNEL_WORKER_ENABLED=false` |
| Credentials / secrets | **Built, dormant** | encrypted store + SecretProvider; no key set ⇒ inert |
| Mapping management | **Built** | versioned + append-only history + audit |
| Outbound sync | **QTCN real (in-process); 3P capable, OFF** | `CHANNEL_HTTP_ENABLED=false`, no activations |
| Inbound webhook | **Built, route gated OFF** | `CHANNEL_WEBHOOK_ENABLED=false` |
| Booking Engine v1 | **Built, DI-only** | orchestration gate; reuses booking_store idempotency |
| Frontend SPA | **Aligned, minimal** | dual-error apiClient; normalize-absorbed; one channel view |

## 3. Health signals
- **Tests:** 569/0/3 across 73 files — green, additive growth, zero regressions across all P23/P24 work.
- **Default runtime = unchanged:** every P24 subsystem is behind a default-off flag or DI-only and
  unconsumed by routes. Booting today behaves exactly as before this phase began.
- **Coupling discipline held:** Channel ↔ PMS is events-in/commands-out only; Booking Engine has no
  direct PMS dependency; credentials never leave the SecretProvider; multi-tenant RLS on every store.

## 4. Gaps & debts (factual)

| # | Gap | Severity | Note |
|---|---|:---:|---|
| G1 | **Booking Engine has no product entry point** | HIGH (for value) | DI-only; no route/UI consumes `createBooking` yet |
| G2 | **No UI control layer** | HIGH | SPA has one read-only channel view; no booking/mapping/credential/worker admin screens |
| G3 | **Worker not wired to the live sync queue** | MED | B6 worker operates on its own lease queue; not bridged to the subscriber queue (real processor pending) |
| G4 | **ChannelManagerCore still on legacy contract** | MED | Migration M4 (core → canonical registry) deferred; two adapter taxonomies coexist (one deprecated) |
| G5 | **Persistence/worker/webhook unproven on real Postgres** | MED | db-mode validated via fake client only; needs a real-DB integration pass + `withTenant` RLS wiring |
| G6 | **Availability engine provider not wired** | MED | Booking Engine availability defaults to "unbounded" (no overbooking block) until a PMS provider is injected |
| G7 | **No AI / CRM / Forecasting orchestration** | LOW (future) | hooks compatible; not started |
| G8 | **Legacy UI footprints unaudited** | LOW (future) | V24/V30/GreenKey remnants flagged for the UI phase (see §7) |

## 5. Recommended next phase

Two credible directions; recommendation follows.

| Option | Unlocks | Risk | Readiness |
|---|---|:---:|---|
| **A. UI Control Layer (Channel Manager + Booking Engine admin)** | Makes everything built *usable*: mapping/credential/worker/sync dashboards + a direct-booking screen | MED (UI-heavy; legacy-footprint cleanup) | High — backends exist, contract converged |
| **B. AI WhatsApp Booking Agent (Phase 1)** | NL → BookingService → PMS → OTA sync | MED | High — Booking Engine + PMS + OTA all exist |
| C. Real-DB hardening (db-mode + worker bridge, G3/G5) | Production durability | LOW-MED | Medium — needs a live Postgres |

### Recommendation: **Option A — UI Control Layer first**, then B.
Rationale: the entire P24 build is **invisible and unconsumed** today (G1, G2). A thin control/admin
UI (a) turns the Booking Engine into a real product entry point, (b) surfaces mapping/credential/worker
state operators need to safely flip the OTA flags, and (c) is the natural place to retire legacy UI
footprints (§7). The AI agent (B) becomes a thin client of the same BookingService afterward, so A
de-risks and accelerates B. Sequence: **A (UI control + direct booking) → B (AI agent) → C (real-DB
hardening) in parallel.**

A pre-req sliver worth folding into A or doing just before: **wire the availability provider (G6)** and
expose **one Booking Engine route** so the UI has something to call.

## 6. Suggested phase boundary (for the next, separate approval)
- In scope: minimal Booking Engine API route(s) + a control/admin UI consuming existing services; wire
  availability provider; surface flag/worker/mapping/credential status (read-mostly).
- Out of scope (still): flipping OTA HTTP live, AI/CRM/Forecasting, real-DB cutover.

## 7. UI Governance Rule (binding for any future UI phase)
When UI work begins, perform a **legacy-footprint audit and removal** before/with new UI:
- V24 references · V30 references · GreenKey branding remnants · deprecated menus · duplicate
  dashboards · legacy routes · unused assets · hidden legacy modules.
The final UI must present a **single unified QYRVIA experience**. (No UI was touched in this audit.)

## 8. Constraints honored
✅ Audit only · ✅ No code / schema / API / UI changes · ✅ No commits.

**STOP after this audit report. Await approval before any implementation.**
