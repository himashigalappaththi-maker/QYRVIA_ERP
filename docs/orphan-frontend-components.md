# Orphan Frontend Components (Phase 35)

Frontend code not reachable from navigation, or calling missing/stale APIs.

## Unrouted views
**None.** All 17 view modules in `src/modules` are registered in `app/app.js`
`VIEWS` and have a matching entry in `app/routes.js`. 1:1 mapping verified.

## Components not reached from navigation
**None orphaned.** All components are used by the shell or views:
- `Layout.js`, `Sidebar.js`, `Topbar.js` — shell (`renderShell`)
- `PropertySwitcher.js` — invoked from shell topbar (multi-property)
- `AssistantLauncher.js` — shell
- `Toast.js`, `overlay.js`, `ui.js` — shared UI primitives used across views

## Views/buttons calling missing or stale backend APIs
**None.** Every `services.*` call resolves to an endpoint that exists on the
backend (cross-checked against [backend-api-inventory.md](./backend-api-inventory.md)).
Grep confirms **no direct `api.*`/`fetch` calls** in views that could drift.

## Dormant (wired but never invoked) service methods
Not orphan *components*, but client methods defined in `services/index.js` with no
caller. These point at real backend routes and are safe; they represent UI not yet
built (see [frontend-screen-inventory.md](./frontend-screen-inventory.md) and
[missing-ui-features.md](./missing-ui-features.md)):
`groups.*`, `vouchers.*`, `rooms.byNumber/create/createRoomType/createFeature/attachFeature`,
`ratePlans.create/attachMealPlan`, `mealPlans.byId/create`, `childPolicies.byId`,
`billing.invoiceByNumber/allocate`, `revenue.rate/setRatePlan`,
`finance.costCenterById/updateCostCenter/revenueMap/upsertRevenueMap/deleteRevenueMap/postLedger/validateLedger/revertLedger`,
`channel.confirmBooking/cancelBooking`.

## Conclusion
No dead views or components, and no stale API calls. The only "orphan" surface is
**dormant-but-valid** service methods awaiting UI controls.
