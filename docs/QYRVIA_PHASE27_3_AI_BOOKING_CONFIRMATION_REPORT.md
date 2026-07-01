# QYRVIA ERP — Phase 27.3: AI Booking Confirmation

**Version:** V35
**Date:** 2026-06-24
**Status:** ✅ Implemented + validated. Default OFF. Awaiting approval before Phase 27.4 (AI Hotel Copilot).

---

## 1. Summary

Phase 27.3 adds a **post-booking confirmation layer** that turns Booking Engine
outcomes into guest-facing confirmation messages. It is a pure **consumer** of the
booking events the Booking Engine already emits (`booking.created`, `booking.updated`,
`booking.cancelled`, `booking.rejected`) via its existing `onEvent` DI hook. It:

- **decides** auto-send vs. human escalation vs. suppress (deterministic decision tree),
- **renders** a confirmation from a deterministic template (no LLM — booking references,
  amounts and dates are always system-rendered),
- **delivers** through an idempotent, retry/DLQ-backed queue over a **mock transport**
  (no external network calls), and
- **exposes** a read + operational REST surface at `/api/ai-confirmation`.

### Hard guarantees preserved
- PMS remains the source of truth; confirmation performs **no PMS/OTA writes, no DB mutation, no schema change**.
- Booking references are **system-rendered, never LLM-generated**.
- Multi-tenant isolation: all API reads are scoped by `req.ctx.tenantId`.
- **Safe-by-default:** `AI_CONFIRMATION_ENABLED=false` → nothing is built, the Booking
  Engine runs with `onEvent=undefined` (zero overhead, zero behavior change), and the
  `/api/ai-confirmation/*` routes do not exist (empty router).
- A confirmation failure can **never** affect a booking write (`onEvent` is synchronous,
  never throws, and schedules delivery fire-and-forget).

---

## 2. Workflow Diagram

```
 ┌─────────────────────────────────────────────────────────────────────────┐
 │  Booking Engine (unchanged)                                               │
 │  createBooking / updateBooking / cancelBooking → commandBus → PMS         │
 │        │ emit('booking.*', meta)   ← already-supported onEvent DI hook    │
 └────────┼──────────────────────────────────────────────────────────────────┘
          │  (only wired when AI_CONFIRMATION_ENABLED=true)
          ▼
 ┌──────────────────────────┐
 │  confirmationService      │
 │  .onEvent(event)          │  sync, never throws
 └──────────┬───────────────┘
            ▼
   resolve recipient (wa:<num> | explicit | none)
   resolve AI confidence (event.ai_confidence ?? 1.0)
            ▼
 ┌──────────────────────────┐
 │  escalationPolicy         │  decision tree (§3)
 │  .decideConfirmation()    │
 └───┬───────────┬───────┬───┘
 suppress     escalate  auto_confirm
     │           │          │
     ▼           ▼          ▼
  suppressed[] escalations[] confirmationTemplates.render()  (deterministic, no LLM)
  (log only)  (staff queue)        │
                                    ▼
                         ┌────────────────────────┐
                         │  confirmationQueue      │  idempotent (dedup by key)
                         │  enqueue → drain        │  retry+backoff → DLQ
                         └──────────┬─────────────┘
                                    ▼
                            transport.send()         MOCK by default (outbox[])
                                    │                (injectable: real WhatsApp 27.2+)
                          ┌─────────┴─────────┐
                          ▼                   ▼
                       sent[]            deadLetter[]  (replayable via API)
```

---

## 3. Decision Tree (escalationPolicy.js)

`decideConfirmation(event, { recipient, confidence, autoSend, minConfidence })`
→ `{ decision, reasons[] }`. Pure function, evaluated top-down:

```
event.type?
 ├─ "booking.rejected" ........................... SUPPRESS  ["booking_rejected"]
 ├─ not in {created, updated, cancelled} ......... SUPPRESS  ["unsupported_event"]
 └─ confirmable outcome
       ├─ recipient missing? ..................... ESCALATE  ["no_recipient"]
       ├─ confidence < minConfidence? ........... ESCALATE  ["low_confidence"]
       ├─ autoSend === false? ................... ESCALATE  ["manual_approval_mode"]
       └─ otherwise ............................. AUTO_CONFIRM ["auto"]
```

- **SUPPRESS** — nothing guest-facing; recorded in `suppressed[]` for audit.
- **ESCALATE** — message is still *rendered* and handed to staff via `escalations[]`
  (the human-follow-up queue); nothing is auto-delivered.
- **AUTO_CONFIRM** — message rendered + enqueued for delivery.

Real bookings carry no `ai_confidence`, so confidence defaults to `1.0` (≥ threshold)
→ they auto-confirm. `low_confidence` only triggers for AI-sourced events that attach a
confidence below `AI_CONFIRMATION_MIN_CONFIDENCE` (default `0.5`).

---

## 4. Escalation Logic

Escalations are the human-in-the-loop safety valve. An escalated item records the
originating event, the resolved recipient (if any), the **pre-rendered message** (so a
staff member can send it as-is), the reasons, and a timestamp.

| Trigger | Reason code | Operational meaning |
|---|---|---|
| No deliverable contact | `no_recipient` | OTA/walk-in booking with no messaging channel → staff contacts guest manually |
| AI confidence below threshold | `low_confidence` | AI extraction uncertain → human verifies before sending |
| Manual-approval mode (`AUTO_SEND=false`) | `manual_approval_mode` | Every confirmation is staged for staff approval (soft launch / high-touch property) |

Escalations are surfaced via `GET /api/ai-confirmation/escalations` (tenant-scoped).

---

## 5. Confirmation Template System (confirmationTemplates.js)

- **Deterministic, system-rendered. No LLM.** A template is a pure function of event
  fields; reference / amount / dates are interpolated by the system.
- Keyed by **event type → locale**, with `en` as the fallback locale (i18n-ready).
- **Graceful degradation:** missing guest name → "there"; missing reservation id →
  "(pending)"; amount/stay lines are omitted when absent.
- Covers `booking.created` (confirmation), `booking.updated` (modification),
  `booking.cancelled` (cancellation). `booking.rejected` has no template (suppressed).

Example (`booking.created`):
```
Hi John Smith, your booking is confirmed.
Reference: res-1
Stay: 2026-07-01 -> 2026-07-03
Total: 230 USD
We look forward to hosting you. Reply here if you need anything.
```

API: `renderConfirmation(event, { locale })`, `hasTemplate(type)`, `listTemplates()`.

---

## 6. Queue Design (confirmationQueue.js)

In-memory FIFO outbound queue. Reuses the channel-manager `RetryPolicy` (exponential
backoff) for delivery retries — no duplicated backoff math.

| Property | Behavior |
|---|---|
| **Idempotency** | Dedup by `key = tenant\|channel\|type\|reservation_id\|external_ref`. A duplicate booking event is **delivered at most once** (`{deduped:true}`). |
| **Retry** | Transient `transport.send` failure → exponential backoff (default `maxAttempts=4`, `baseMs=50`, `factor=2`). |
| **Dead-letter** | An item that exhausts all attempts is moved to `deadLetter[]` with the error + attempt count. |
| **Isolation** | One item failing never aborts the drain of the rest (partial-failure isolation). |
| **Replay** | `replayDeadLetter()` re-queues dead-lettered items (bypassing dedup, since the key was already accepted and only delivery failed). |
| **Determinism** | `clock` + `sleep` are injectable → tests run instantly with no wall-clock waits. |

`stats()` → `{ pending, sent, dead }`. No persistence (in-memory, additive, no schema).

---

## 7. REST API (`/api/ai-confirmation`)

Mounted behind the standard protected chain (JWT + identity + business date). Reuses
**existing reserved AI permissions** — no new permission codes, **no migration**.
When confirmation is OFF the router is empty (routes do not exist).

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/status` | `ai.conversation.read` | Counters + current mode (auto-send, min-confidence), tenant-scoped |
| GET | `/escalations` | `ai.conversation.read` | Confirmations awaiting staff follow-up (tenant-scoped) |
| GET | `/dead-letter` | `ai.conversation.read` | Confirmations that failed every delivery attempt (tenant-scoped) |
| POST | `/drain` | `ai.whatsapp.config` | Flush the pending queue now |
| POST | `/replay` | `ai.whatsapp.config` | Re-queue dead-letters, then drain |

All reads filter by `req.ctx.tenantId` → multi-tenant isolation preserved.

---

## 8. Files

**New (`server/src/ai-confirmation/`)**
- `confirmationTemplates.js` — deterministic, system-rendered templates
- `escalationPolicy.js` — decision tree (suppress / escalate / auto_confirm)
- `confirmationQueue.js` — idempotent queue + retry + DLQ + replay (reuses `RetryPolicy`)
- `confirmationService.js` — orchestration + mock transport + resolvers + tenant-scoped accessors
- `index.js` — `buildAiConfirmation` DI factory (config-driven, default OFF)
- `api/confirmationHandlers.js` — thin HTTP handlers
- `api/confirmation.routes.js` — RBAC-gated routes (empty when OFF)

**New tests**
- `server/test/aiConfirmation.test.js` — 21 tests

**Modified (additive, gated)**
- `server/src/config/env.js` — `AI_CONFIRMATION_ENABLED/AUTO_SEND/MIN_CONFIDENCE/TRANSPORT` (all default-safe)
- `server/src/index.js` — build confirmation when enabled; pass `onEvent` into the Booking Engine; add `aiConfirmation` to app deps
- `server/src/routes/api.js` — mount `/ai-confirmation`

No PMS, OTA, worker, webhook, schema, or UI files changed.

---

## 9. Test Results

```
Phase 27.3 suite (server/test/aiConfirmation.test.js):  21 pass / 0 fail
```

Coverage:
1. `AI_CONFIRMATION_ENABLED` defaults OFF (safe baseline)
2. Templates render created/updated/cancelled with system-rendered reference + amount + stay; rejected → null; graceful degradation
3. Decision tree: suppress (rejected / unsupported), escalate (no recipient / low confidence / manual mode), auto_confirm
4. Recipient resolution (`wa:` decode, explicit preference, none)
5. Queue: idempotent dedup (at-most-once)
6. Queue: retry-then-success
7. Queue: dead-letter after exhaustion + partial-failure isolation
8. Service: auto-confirm enqueues then delivers on drain
9. Service: duplicate event delivered once
10. Service: escalate (no recipient) delivers nothing
11. Service: manual-approval mode escalates, message still prepared
12. Service: suppress rejection
13. Integration: Booking Engine `onEvent` drives a real confirmation
14–16. API: tenant-scoped status, tenant-scoped escalations, replay re-queue+drain, route gating (empty when OFF)

---

## 10. Regression Summary

| Suite | Before (baseline) | After Phase 27.3 |
|---|---|---|
| Backend | 607 pass / 0 fail / 3 skip | **628 pass / 0 fail / 3 skip** |
| Frontend | 28 pass / 0 fail | 28 pass / 0 fail (untouched) |

`628 = 607 + 21` new tests. **Zero regressions** across the full backend suite. No
frontend files were touched.

---

## 11. Activation Guide

Default state is OFF; no action needed to stay safe. To enable confirmations:

```bash
# .env
AI_CONFIRMATION_ENABLED=true        # master switch (default false)
AI_CONFIRMATION_AUTO_SEND=true      # false => every confirmation escalates (manual approval)
AI_CONFIRMATION_MIN_CONFIDENCE=0.5  # escalate AI events below this confidence
AI_CONFIRMATION_TRANSPORT=mock      # mock only in this phase (no external calls)
```

On boot you will see `[boot] AI booking confirmation ready`; the Booking Engine then
receives the confirmation `onEvent` hook. Inspect/operate via:

```
GET  /api/ai-confirmation/status        (ai.conversation.read)
GET  /api/ai-confirmation/escalations   (ai.conversation.read)
GET  /api/ai-confirmation/dead-letter   (ai.conversation.read)
POST /api/ai-confirmation/drain         (ai.whatsapp.config)
POST /api/ai-confirmation/replay        (ai.whatsapp.config)
```

> Transport is `mock` in Phase 27.3 — delivery is recorded to an in-memory outbox, never
> sent externally. A real WhatsApp transport (Phase 27.2) can be injected without
> changing the confirmation logic, because the transport is a DI dependency.

---

## 12. Rollback

```bash
AI_CONFIRMATION_ENABLED=false
```

Disables instantly: confirmation is not built, the Booking Engine runs with no
`onEvent`, and the `/api/ai-confirmation/*` routes return an empty router. **No code
removal required.**

---

## 13. Scope Boundary (per directive)

Implemented **only** Phase 27.3 + validation. **Not** started: CRM, Revenue Forecasting,
UI expansion, ChannelManager → Canonical Registry migration. **Awaiting explicit
approval before Phase 27.4 (AI Hotel Copilot).**
```
