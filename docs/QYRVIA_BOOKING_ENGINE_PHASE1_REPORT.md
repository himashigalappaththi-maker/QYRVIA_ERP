# QYRVIA Booking Engine — Phase 1 Implementation Report

**Scope:** Booking Engine v1 as a **pure orchestration layer** on top of PMS + the existing
channel/OTA infrastructure, with **zero backend disruption**. DI only; no PMS / OTA / worker / queue /
webhook / UI changes.

---

## 1. Files
**Created**
- `server/src/booking-engine/bookingService.js` — orchestrator (create/update/cancel)
- `server/src/booking-engine/pricingEngine.js` — deterministic pricing
- `server/src/booking-engine/availabilityEngine.js` — read-only overbooking guard
- `server/src/booking-engine/bookingValidator.js` — validation layer
- `server/src/booking-engine/index.js` — factory (`buildBookingEngine`)
- `server/test/booking-engine.test.js` — 10 tests
- `docs/QYRVIA_BOOKING_ENGINE_PHASE1_REPORT.md` — this report

**Modified**
- `server/src/index.js` — DI only (BookingService injected into `createApp` deps)

## 2. Architecture
**BookingService** — unified entry `createBooking()` / `updateBooking()` / `cancelBooking()`.
Pipeline: `input → availability → pricing → validator → commandBus → PMS`. Every write goes through
`commandBus.dispatch('pms.reservation.create|update|cancel', payload, ctx)`.
✔ No direct PMS dependency · ✔ No schema change · ✔ Stateless orchestration.

## 3. Pricing Engine (deterministic v1)
`total = base_rate + taxes − discounts`, `base_rate = ratePerNight × nights`, `taxes = base_rate × 15%`.
Example `quote({ratePerNight:100, nights:1})` → `{ base_rate:100, taxes:15, discounts:0, total:115,
currency:'USD' }`. No external calls, no AI, test-pinned (no drift).

## 4. Availability Engine
Reads an injected inventory snapshot provider (read-only); `available_rooms <= 0 ⇒ reject`. No mutation,
no side effects; PMS remains source of truth. Default provider is unbounded (inert) until a real
provider is wired.

## 5. Validation Layer
Enforces date validity, room_type existence, the PMS-aligned adult rule (≥1 adult), availability, and
pricing success. Reject path: `{ ok:false, reason:'VALIDATION_FAILED', detail:[...] }`.

## 6. Unified Flow (live behavior)
`Direct / OTA / AI / Front Desk → BookingService → AvailabilityEngine → PricingEngine →
BookingValidator → commandBus → PMS`. OTA inbound path unchanged; AI hook compatible; direct booking
now exists as a product entry point.

## 7. Idempotency (reused)
Inherits the channel safety model: `booking_store UNIQUE(tenant_id, channel, external_ref)`. A
duplicate `external_ref` routes to **UPDATE**, never a second CREATE — no double PMS call possible.

## 8. Events (metadata-only)
`booking.created` / `booking.updated` / `booking.cancelled` / `booking.rejected` emitted via an
injectable `onEvent` callback (default no-op; no sensitive payload — verified the guest name is absent
from event metadata).

## 9. Test coverage (10/10 passing)
direct → create dispatched · update routing · cancel dispatched · unavailable → rejection · adult-rule
rejection · deterministic pricing · OTA-origin booking through the same gate · duplicate external_ref →
update not duplicate · AI-style payload accepted · full pipeline integration (store link + event).

## 10. Validation summary
- **Backend: 559 / 0 / 3 → 569 / 0 / 3 (+10 tests)** — **zero regressions**.
- System impact: PMS unchanged · OTA unchanged · webhook unchanged · worker unchanged · queue
  unchanged · UI unchanged.

## 11. Architectural outcome
A unified revenue entry layer: the Booking Engine is the single orchestration gate for ALL reservation
creation (Direct / OTA / AI / Front Desk), sitting above PMS and reusing OTA-grade idempotency.

## 12. Rollback
DI-only and unconsumed by routes ⇒ inert. To revert: delete `server/src/booking-engine/*` and
`server/test/booking-engine.test.js`, and remove the `bookingEngine` DI lines from `index.js`.

**Next recommended step:** AI WhatsApp Booking Agent (Phase 1) — natural language → BookingService →
PMS → OTA sync. The booking engine, PMS integration, and OTA sync now all exist.
