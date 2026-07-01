# Critical Workflow Validation (Phase 35)

Static end-to-end mapping of each critical workflow across backend routes,
service methods, and views. ✅ = full chain present · ⚠️ = chain works but a step
is derived/indirect · ❌ = step has no frontend control.

## 1. Reservation → Check-in → Stay → Billing → Checkout

| Step | Backend | Service | View | Status |
|---|---|---|---|---|
| Create reservation | `POST /pms/reservations` or `/booking/create` | reservations.create / booking.create | Booking, Reservations | ✅ |
| Confirm | `POST /pms/reservations/:id/confirm` | reservations.confirm | Reservations | ✅ |
| Check-in | `POST /pms/reservations/:id/checkin` | reservations.checkIn | FrontDesk | ✅ |
| In-house view | `GET /pms/frontdesk/inhouse` | (derived from reservations.list) | FrontDesk | ⚠️ |
| Post charges | `POST /pms/folios/:id/charges` | billing.postCharge | Billing | ✅ |
| Open/list folio | `GET /pms/folios[/:id]` | — | — | ❌ (folio id must come from elsewhere) |
| Cash payment | `POST /pms/folios/:id/payments/cash` | billing.cashPayment | Billing | ✅ |
| Issue invoice | `POST /pms/invoices/issue` | billing.issueInvoice | Billing | ✅ |
| Checkout | `POST /pms/reservations/:id/checkout` | reservations.checkOut | FrontDesk | ✅ |

**Verdict:** ⚠️ usable end-to-end; the **folio-open** step depends on an id from
the reservation/billing context (no folio browser). Recommend wiring `folios` reads.

## 2. Housekeeping lifecycle
| Step | Backend | Service | View | Status |
|---|---|---|---|---|
| View room status board | `GET /pms/housekeeping/room-status` | (derived from rooms.list) | Housekeeping | ⚠️ |
| List tasks | `GET /pms/housekeeping/tasks` | — | Housekeeping | ⚠️ |
| Create task | `POST /pms/housekeeping/tasks` | housekeeping.createTask | Housekeeping | ✅ |
| Assign | `.../:id/assign` | housekeeping.assignTask | Housekeeping | ✅ |
| Complete | `.../:id/complete` | housekeeping.completeTask | Housekeeping | ✅ |

**Verdict:** ⚠️ writes complete; dedicated read endpoints unused (board derives from rooms).

## 3. Maintenance lifecycle
No dedicated maintenance routes/commands. Maintenance is modeled as a housekeeping
**task type** (`MAINTENANCE`, alongside `DEEP_CLEAN`, `INSPECT`, …) — present both
in the backend folio/task taxonomy (`commands/pms/checkinFolio.js`) and surfaced in
the frontend Housekeeping view (`TASK_TYPES`). **Verdict:** ⚠️ maintenance is
trackable via housekeeping tasks (create/assign/complete wired), but there is **no
standalone maintenance module** (work orders, asset registry, PPM schedules) on
either side — a product gap, not an integration gap.

## 4. Night audit
| Step | Backend | Service | View | Status |
|---|---|---|---|---|
| Status | `GET /pms/night-audit/status` | — | NightAudit | ⚠️ |
| History | `GET /pms/night-audit/history` | — | NightAudit | ⚠️ |
| Run | `POST /pms/night-audit/run` | nightAudit.run | NightAudit | ✅ |
| Schedule | `POST /pms/night-audit/schedule` | nightAudit.schedule | NightAudit | ✅ |

**Verdict:** ⚠️ run/schedule wired; status/history reads not consumed.

## 5. Folios / Billing
Covered in workflow 1. Charges, cash payments, invoice issue/void, allocations all
✅. Folio listing/detail ❌. Payment allocation read ✅ (`billing.allocations`),
write `billing.allocate` defined-but-unused ⚠️.

## 6. Channel / OTA / Booking engine
| Step | Backend | Service | View | Status |
|---|---|---|---|---|
| Channel status | `GET /channel/status` | channel.status | Channel | ✅ |
| Control snapshot | `GET /channel/control` | channel.control | Control | ✅ |
| Sync rates/inventory | `POST /channel/sync/*` | channel.syncRates/syncInventory | Channel | ✅ |
| Sync bookings | `POST /channel/bookings/sync` | channel.syncBookings | Channel | ✅ |
| Confirm/cancel booking | `POST /channel/bookings/confirm|cancel` | defined, unused | — | ⚠️ |
| Booking engine create/update/cancel | `/booking/*` | booking.* | Booking | ✅ |
| Inbound webhook | `POST /channel/webhook/:channel` | — | — | 🔒 OTA ingress |

**Verdict:** ✅ core OTA + booking-engine flow is fully wired.

## 7. CRM / Revenue / Reporting
| Area | Backend | Service | View | Status |
|---|---|---|---|---|
| Guests (CRM-lite) | `/pms/guests*` | guests.* | Guests | ✅ |
| Revenue rate/grid/forecast/kpis/dashboard | `/revenue/*` | revenue.* | Revenue | ✅ |
| Revenue override | `POST /revenue/override` | revenue.override | Revenue | ✅ |
| Finance reports | `/finance/reports/*` | finance.report* | Finance | ✅ |
| Platform analytics/metrics | `/platform/*` | platform.* | Admin | ✅ |

**Verdict:** ✅ no full CRM module, but guest management + revenue + reporting are wired.

## Summary
- Fully wired workflows: **Channel/OTA/Booking**, **CRM/Revenue/Reporting**.
- Usable-with-gaps: **Reservation→Checkout** (folio browser), **Housekeeping** &
  **Night Audit** (dedicated reads bypassed).
- Maintenance: ⚠️ available as a housekeeping task type; no standalone module.
