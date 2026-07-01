# Backend ↔ Frontend Coverage Matrix (Phase 35)

Status: ✅ visible+usable · ⚠️ partial (service exists, some endpoints/forms missing) ·
🔒 intentionally backend-only · ❌ no frontend access (documented gap).

## Route-group level

| Backend group | Frontend surface | Status |
|---|---|---|
| `/auth` | Login view, session, PropertySwitcher | ✅ |
| `/core` (generic command bus) | — | 🔒 internal |
| `/connector`, `/connectors` | — | ❌ gap |
| `/settings` | — | ❌ gap |
| `/files` | — | ❌ gap |
| `/webhooks` | — | ❌ gap |
| `/jobs` (scheduler) | — | ❌ gap |
| `/notifications` | — | ❌ gap |
| `/iam` (users/roles) | — | ❌ gap (high value) |
| `/pms` | Reservations/FrontDesk/Guests/Rooms/Availability/RatePlans/Billing/Housekeeping/NightAudit | ⚠️ partial |
| `/finance` | Finance (Accounting) view | ⚠️ partial |
| `/revenue` | Revenue view | ✅ |
| `/channel` | Channel + Control views | ✅ |
| `/booking` | Booking view | ✅ |
| `/platform` | Admin view | ⚠️ partial (no `/metrics*`, no `integrations webhook/sync`) |
| `/ai-confirmation` | — | 🔒 default OFF (documented gap) |

## /pms endpoint-level

| Endpoint | Service method | View | Status |
|---|---|---|---|
| reservations list/byNumber/create/confirm/cancel/no-show | reservations.* | Reservations | ✅ |
| reservations checkin/checkout | reservations.checkIn/checkOut | FrontDesk | ✅ |
| reservations PUT update | — | — | ❌ (no edit form; service.update absent) |
| reservations room-move | — | — | ❌ |
| reservations check-in/check-out/force/early/late variants | (only /checkin,/checkout used) | FrontDesk | 🔒 extra variants backend-only |
| frontdesk arrivals/departures/inhouse (Q) | — (FrontDesk derives from reservations.list) | FrontDesk | ⚠️ dedicated reads unused |
| guests list/byId/create/blacklist | guests.* | Guests | ✅ |
| rooms list/status/activate/deactivate | rooms.* | Rooms | ✅ |
| rooms create / room-types create / features create+attach | rooms.create… (defined, unused) | — | ❌ (no creation forms) |
| availability + calendar | availability.* | Availability | ✅ |
| rate-plans list/byId | ratePlans.list/byId | RatePlans | ✅ |
| rate-plans create / meal-plan attach | ratePlans.create/attachMealPlan (unused) | — | ❌ |
| meal-plans list/byId/create | mealPlans.list used; byId/create unused | RatePlans | ⚠️ |
| child-policies list/byId/create | childPolicies.list used | — | ⚠️ read-only |
| folios charges/cash/close/allocate | billing.* | Billing | ✅ |
| folios GET list/byId (folio.read) | — | — | ❌ (no folio browser) |
| folios allocations GET | billing.allocations | Billing | ✅ |
| invoices list/byId/issue/void | billing.* | Billing | ✅ |
| invoices byNumber | billing.invoiceByNumber (unused) | — | ⚠️ |
| reservation-groups (all) | groups.* (defined, unused) | — | ❌ (no group UI) |
| vouchers (all) | vouchers.* (defined, unused) | — | ❌ (no voucher UI) |
| housekeeping create/assign/complete | housekeeping.* | Housekeeping | ✅ |
| housekeeping tasks/room-status GET (Q) | — | Housekeeping (uses rooms) | ⚠️ dedicated reads unused |
| night-audit run/schedule | nightAudit.* | NightAudit | ✅ |
| night-audit status/history GET (Q) | — | NightAudit | ⚠️ reads unused |

## /finance endpoint-level

| Endpoint | Service | View | Status |
|---|---|---|---|
| cost-centers list/byId/create/update/disable | finance.* (create/list/disable used) | Finance | ⚠️ update/byId unused |
| revenue-map list/upsert/delete | finance.* (defined, unused) | — | ❌ no revenue-map UI |
| ledger post/validate/revert | finance.* (defined, unused) | — | 🔒/❌ (read used; writes unused) |
| ledger by-reference | finance.ledgerByReference | Finance | ✅ |
| reports cost-center/revenue | finance.report* | Finance | ✅ |

## /platform endpoint-level

| Endpoint | Service | View | Status |
|---|---|---|---|
| admin/metrics, admin/logs, admin/audit | platform.metrics/logs/audit | Admin | ✅ |
| enterprise/properties, analytics, config | platform.* | Admin | ✅ |
| integrations/status | platform.integrations | Admin | ✅ |
| integrations/webhook, integrations/sync (POST) | — | — | 🔒 ops-only |
| metrics, metrics/summary (Phase 33/34) | — | — | 🔒 Prometheus scrape |

## Coverage summary
- Functional backend groups (excl. health): **17**
- Fully covered (✅): auth, revenue, channel, booking = **4**
- Partial (⚠️): pms, finance, platform = **3**
- Intentionally backend-only (🔒): core, ai-confirmation = **2**
- No frontend access (❌ gap): connector(s), settings, files, webhooks, jobs, notifications, iam = **7**
