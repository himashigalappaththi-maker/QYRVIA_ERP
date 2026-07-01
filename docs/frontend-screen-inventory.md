# Frontend Screen Inventory (Phase 35)

Static audit of `frontend-stitch/src`. SPA: hash router (`app/router.js`),
route table + RBAC nav (`app/routes.js`), view registry (`app/app.js`),
domain service layer (`services/index.js`) over `services/apiClient.js`.

## Navigable routes (app/routes.js)

| Path | id | Section | View module | Nav permission |
|---|---|---|---|---|
| `/login` | login | (hidden) | auth/Login.view.js | public |
| `/dashboard` | dashboard | Overview | dashboard/Dashboard.view.js | none |
| `/booking` | booking | Front Office | booking/Booking.view.js | `pms.reservation.write` |
| `/reservations` | reservations | Front Office | reservations/Reservations.view.js | `pms.reservation.read` |
| `/frontdesk` | frontdesk | Front Office | frontdesk/FrontDesk.view.js | `pms.reservation.read` |
| `/guests` | guests | Front Office | guests/Guests.view.js | `pms.guest.read` |
| `/rooms` | rooms | Inventory & Rates | rooms/Rooms.view.js | `pms.room.read` |
| `/availability` | availability | Inventory & Rates | availability/Availability.view.js | `pms.availability.read` |
| `/rateplans` | rateplans | Inventory & Rates | rateplans/RatePlans.view.js | `pms.rateplan.read` |
| `/revenue` | revenue | Revenue & Billing | revenue/Revenue.view.js | `revenue.snapshot.read` |
| `/billing` | billing | Revenue & Billing | billing/Billing.view.js | `invoice.read` |
| `/housekeeping` | housekeeping | Operations | housekeeping/Housekeeping.view.js | `housekeeping.read` |
| `/nightaudit` | nightaudit | Operations | nightaudit/NightAudit.view.js | `night_audit.read` |
| `/channel` | channel | Operations | channel/Channel.view.js | `channel.mapping.read` |
| `/finance` | finance | Finance | finance/Finance.view.js | `cost_center.read` |
| `/control` | control | System | control/Control.view.js | `channel.mapping.read` |
| `/admin` | admin | System | platform-admin/Admin.view.js | `bi.dashboard.read` |

**17 routes, 17 view modules — 1:1 mapping, no unrouted views.**

## Components
`Layout.js`, `Sidebar.js` (RBAC + section nav), `Topbar.js`, `PropertySwitcher.js`
(multi-property), `AssistantLauncher.js`, `Toast.js`, `overlay.js`, `ui.js`.

## Service layer groups (services/index.js)
`auth, reservations, groups, guests, rooms, availability, ratePlans, mealPlans,
childPolicies, billing, vouchers, housekeeping, nightAudit, revenue, finance,
channel, booking, platform`.

## Service methods defined but NOT referenced by any view
(from grep of `services.*` across `src/modules`; also used by app.js/PropertySwitcher where noted)

- `auth.logout` (app.js), `auth.me` / `auth.refresh` (session/apiClient), `auth.properties` / `auth.switchProperty` (PropertySwitcher) — **used outside modules, OK**
- `groups.*` (create/byId/roomingList/addRoom/cancelAll/checkinAll) — **unused** (no group UI)
- `vouchers.*` (byNumber/issue/redeem/cancel) — **unused** (no voucher UI)
- `rooms.byNumber`, `rooms.create`, `rooms.createRoomType`, `rooms.createFeature`, `rooms.attachFeature` — **unused** (no creation forms)
- `ratePlans.create`, `ratePlans.attachMealPlan`, `mealPlans.byId`, `mealPlans.create`, `childPolicies.byId` — **unused**
- `billing.invoiceByNumber`, `billing.allocate` — **unused**
- `revenue.rate`, `revenue.setRatePlan` — **unused**
- `finance.costCenterById`, `updateCostCenter`, `revenueMap`, `upsertRevenueMap`, `deleteRevenueMap`, `postLedger`, `validateLedger`, `revertLedger` — **unused**
- `channel.confirmBooking`, `channel.cancelBooking` — **unused**

These are wired-but-dormant client methods (the backend route exists; the UI
control does not yet call it). See [missing-ui-features.md](./missing-ui-features.md).

## No direct API calls in views
Grep confirms **zero** `api.get/post/...` or `fetch(` calls inside `src/modules`;
all backend access flows through `services/index.js`. No stale/ad-hoc endpoints.
