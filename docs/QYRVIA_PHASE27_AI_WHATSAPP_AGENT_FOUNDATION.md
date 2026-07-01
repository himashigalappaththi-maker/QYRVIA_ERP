# QYRVIA Phase 27 — AI WhatsApp Booking Agent (Foundation) — Report

**Objective:** first production-ready AI Booking Agent layer on top of the completed Booking Engine.
**Mocks + abstractions only** — no Meta WhatsApp, no OpenAI/Claude/Gemini. **Default OFF.** The agent
consumes existing services only and never writes PMS/OTA directly.

---

## 1. Architecture
```
WhatsApp (mock transport)
   → whatsappGateway            (inbound/outbound abstraction)
   → aiAgentService             (classify → extract → ephemeral state → act)
        ├─ AIProvider (mock)    (classifyIntent / extractEntities / generateResponse)
        └─ conversationStateStore (ephemeral, TTL, no CRM)
   → BookingService.createBooking / updateBooking / cancelBooking   (the ONLY side effects)
   → commandBus → PMS → Channel Manager → OTA sync
```
**Boundary rules honored:** reuse BookingService · reuse PMS commandBus (via BookingService) · reuse
existing OTA sync · no direct PMS writes · no direct OTA writes · no AI-generated DB mutations ·
events-in/commands-out only · default OFF · no vendor lock-in (provider abstracted).

## 2. Files created
```
server/src/ai-agent/
  aiAgentService.js                         orchestrator (-> BookingService)
  intentClassifier.js                       rule-based intent (new/modify/cancel/availability/rate)
  entityExtractor.js                        rule-based slots (name/dates/occupancy/room/reference)
  conversationStateStore.js                 ephemeral memory (TTL, no persistence)
  provider/index.js                         AIProvider interface + MockAIProvider + factory
  channels/whatsapp/whatsappGateway.js      inbound/outbound + mock transport
  index.js                                  buildAiAgent() factory
server/test/aiAgent.test.js                 10 tests
docs/QYRVIA_PHASE27_AI_WHATSAPP_AGENT_FOUNDATION.md
```
**Modified:** `config/env.js` (`AI_AGENT_ENABLED=false`, `AI_PROVIDER=mock`); `index.js` (gated DI, default off). No PMS/OTA/Booking-Engine/UI/schema changes.

## 3. Conversation flow (slot-filling)
1. Inbound message → `classifyIntent` → `extractEntities` → merge into ephemeral state.
2. **new_booking:** collect required slots one at a time (`guest_name → room_type → arrival →
   departure → adults`); when complete → `BookingService.createBooking({ channel:'AI_WHATSAPP',
   external_ref:'wa:<conversation>', … })` → confirmation with the reservation reference.
3. **modify_booking / cancel_booking:** if no `booking_reference`, ask for it; else
   `updateBooking` / `cancelBooking`.
4. **availability / rate inquiry:** informational reply (no booking, no DB).
5. **unknown:** helpful fallback.
**Continuity:** an `_active_intent` is tracked so follow-up info messages ("2 adults", "res-8") —
which classify as `unknown` — continue the in-progress flow. Cleared once resolved; hidden from the
returned state.

## 4. State model (ephemeral)
`{ guest_name, arrival, departure, adults, children, room_type, booking_reference }` keyed by
conversationId, with a 30-min TTL. **No persistence, no CRM.** `_active_intent` is an internal,
non-exposed continuity marker.

## 5. Provider abstraction (no vendor lock-in)
`AIProvider` interface: `classifyIntent(text)` · `extractEntities(text)` · `generateResponse(ctx)`.
Only `MockAIProvider` is implemented (delegates to the rule-based classifier/extractor + templated
NLG). `buildAiProvider({kind})` selects by config (`AI_PROVIDER`, default `mock`); any non-mock kind
throws `ai_provider_not_available` until Phase 27.1 wires a real provider behind the **same**
interface.

## 6. WhatsApp abstraction (no Meta API)
`whatsappGateway.receive({from, text, ctx})` → agent turn → `transport.send(from, reply)`.
`buildMockWhatsappTransport()` records outbound messages in an `outbox`. No Meta Cloud API; the mock
transport is the only one until Phase 27.2.

## 7. Booking Engine integration & permissions
All reservation actions flow `agent → BookingService.{create,update,cancel} → commandBus → PMS`. The
agent passes the caller's `ctx`, which must carry **`pms.reservation.write`** (per Phase 26.1 — no
`booking.*` permissions introduced). The agent performs **no** direct PMS/OTA writes and **no** DB
mutations of its own.

## 8. Test results
**Backend: 578 / 0 / 3 (581) → 588 / 0 / 3 (591)** (+10, zero regressions). Frontend untouched (28/0).

**Tests (10):** intent classification (all 6 intents) · entity extraction (name/room/dates/occupancy/
reference) · ephemeral state merge/isolation/clear · missing-information flow (collect one slot) ·
**full multi-turn conversation → createBooking → confirmation** · update path · cancel path · cancel
without reference (asks, no PMS call) · unknown → fallback (no booking) · **WhatsApp gateway end-to-end
(inbound → outbound reply via mock transport)**.

## 9. Success criteria
| Criterion | Status |
|---|:---:|
| Mock WhatsApp conversation can request a booking | ✅ |
| Collect required details (slot-filling) | ✅ guest/room/dates/adults |
| Create a reservation through Booking Engine | ✅ `BookingService.createBooking` (ctx-gated) |
| Receive confirmation | ✅ reply carries the reservation reference |
| No direct PMS/OTA coupling | ✅ BookingService only; no PMS/OTA writes |

## 10. Risks
| Risk | Level | Mitigation |
|---|:---:|---|
| Rule-based NLU is shallow | KNOWN (foundation) | deterministic + test-pinned; real NLU is Phase 27.1 behind the same interface |
| Rate is a fixed default (not rate-plan) | MED | `rateResolver` injectable; wire a rate-plan lookup at productionization |
| room_type → id is a naive map (`rt-<label>`) | MED | `roomTypeResolver` injectable; map to real room types when wired to the UI/PMS |
| ctx/permission for the agent principal | MED | agent passes ctx that must hold `pms.reservation.write`; provision a property AI principal |
| Ephemeral state lost on restart | LOW (by design) | conversations are short-lived; persistence is out of scope (no CRM) |
| Accidental enablement | LOW | default OFF; mock provider + mock transport only; no real AI/WhatsApp wired |

## 11. Rollback plan
- **Instant:** keep `AI_AGENT_ENABLED=false` (default) ⇒ agent never constructed; fully inert.
- **Code:** delete `server/src/ai-agent/**` and `server/test/aiAgent.test.js`; revert the `env.js`
  flags and the gated `index.js` block. Nothing else imports the agent.

## 12. Constraints honored
✅ Consume existing services only · ✅ Do not bypass Booking Engine · ✅ No direct PMS/OTA writes ·
✅ No AI DB mutations · ✅ Default OFF · ✅ No vendor lock-in (provider abstracted) · ✅ No Meta WhatsApp ·
✅ No OpenAI/Claude/Gemini · ✅ mocks + abstractions only.

**STOP after implementation & validation. Await approval before Phase 27.1 (real AI provider) or
Phase 27.2 (real WhatsApp transport).**
