# Integration Gap Report (Phase 35) — Hard Gate for Phase 36

Consolidated backend ↔ frontend coverage conclusion. This report satisfies the
Phase 35 hard gate: **every backend capability is classified as (1) frontend-visible,
(2) intentionally backend-only, or (3) a documented gap.**

## Coverage scorecard

| Classification | Count | Items |
|---|---|---|
| ✅ Frontend-visible (full) | 4 groups | auth, revenue, channel, booking |
| ⚠️ Frontend-visible (partial) | 3 groups | pms, finance, platform |
| 🔒 Intentionally backend-only | 4 areas | core command bus, ai-confirmation (OFF), platform `/metrics*`+integration POSTs, channel inbound webhook |
| ❌ Documented gap (no UI) | 7 groups | iam, settings, files, webhooks, jobs, notifications, connectors |

Every one of the 17 functional backend route groups (plus internal handlers) is
accounted for. There are **no unknown/unclassified capabilities**.

## Backend-only confirmation (orphan analysis)
No unintended orphan backend write paths. The 5 routeless commands
(`aggregate.action`, `reservation.create`, `pms.allocation.create/release/release_sweep`)
are all event-driven / scheduled / internal-orchestration. See
[orphan-backend-functions.md](./orphan-backend-functions.md).

## Frontend integrity confirmation
- 17 views ↔ 17 routes (1:1), no unrouted views, no orphan components.
- Zero direct `api.*`/`fetch` in views; all access via `services/index.js`.
- Zero stale endpoints: every `services.*` path resolves to a live backend route.
- Dormant-but-valid service methods exist (awaiting UI) — listed in
  [orphan-frontend-components.md](./orphan-frontend-components.md).

## Documented gaps to carry into Phase 36 (UI build-out backlog)
High: IAM (users/roles), Settings, Reservation edit/room-move, Folio browser, Vouchers, Reservation groups.
Medium: Rooms/RatePlans/MealPlans/ChildPolicy creation forms, Revenue-map, Cost-center edit, manual Ledger ops.
Low: Jobs/Scheduler, Notifications, Webhooks, Files, Connectors.
Read-wiring: FrontDesk arrivals/departures/inhouse, Housekeeping tasks/room-status, Night-audit status/history.
Polish: client-side write-control gating (server already enforces).
Product gap (no backend either): standalone Maintenance module.

## Critical workflow status (static)
- Channel/OTA/Booking: ✅ fully wired
- CRM(guests)/Revenue/Reporting: ✅ fully wired
- Reservation→Check-in→Billing→Checkout: ⚠️ usable (folio-open indirect)
- Housekeeping: ⚠️ usable (reads derived)
- Night audit: ⚠️ usable (reads unused)
- Maintenance: ⚠️ housekeeping task type only (no standalone module, backend + frontend)

See [workflow-validation.md](./workflow-validation.md).

## Hard-gate decision
✅ **GATE PASSED.** Every backend capability is frontend-visible, intentionally
backend-only, or a documented gap. Phase 36 (UI Stitch migration) may proceed, and
should consume the gap backlog above. No backend rewrites required; the only
non-destructive wiring follow-ups are the dormant service methods and the three
bypassed dedicated-read endpoints.

## Deliverables index
- [backend-api-inventory.md](./backend-api-inventory.md)
- [frontend-screen-inventory.md](./frontend-screen-inventory.md)
- [backend-frontend-matrix.md](./backend-frontend-matrix.md)
- [missing-ui-features.md](./missing-ui-features.md)
- [orphan-backend-functions.md](./orphan-backend-functions.md)
- [orphan-frontend-components.md](./orphan-frontend-components.md)
- [workflow-validation.md](./workflow-validation.md)
- [rbac-visibility-audit.md](./rbac-visibility-audit.md)
- [integration-gap-report.md](./integration-gap-report.md) (this file)
