# QYRVIA API Contract Catalog

**Status:** Official API contract reference (frozen as of Phase 22).
**Scope:** every active HTTP endpoint mounted under the Express app (`server/src/app.js` → `routes/api.js`).
**Audience:** frontend integrators, backend maintainers, QA.

This catalog is descriptive — it documents the contract **as it exists today**, including
the deviations from the target envelope. Target standards and the remediation plan live in
[`QYRVIA_PHASE22_API_CONTRACT_FREEZE.md`](./QYRVIA_PHASE22_API_CONTRACT_FREEZE.md).

---

## 1. Global conventions

### 1.1 Mounting & middleware chain
All endpoints are mounted under `/api` (`app.use('/api', apiBuild.build(deps))`).

| Surface | Auth | Tenant ctx | Identity ctx | Business date |
|---|---|---|---|---|
| `/api/health/*` | none | skipped | no | no |
| `/api/auth/*` | per-route (see §3) | no | no | no |
| everything else | **JWT required** | yes | yes | yes |

The protected chain is `authentication → identityContext → businessDateMiddleware`
(`routes/api.js:45-49`). Per-endpoint authorization is enforced with
`requirePermission('<perm>')` (`middleware/authorization.js`).

### 1.2 Standard envelopes (target)
| Operation | Shape |
|---|---|
| READ (query) | `{ "ok": true, "data": ... }` |
| WRITE (command) | `{ "ok": true, "result": ... }` |
| ERROR (target) | `{ "ok": false, "error": { "code": "...", "message": "..." } }` |

Every response also carries `requestId`.

### 1.3 Envelope reality (as implemented)
- **Command bus** (`core/commandBus.js`) → writes return `{ ok:true, result, ...events? }`. ✅ conforms.
- **Query bus** (`core/queryBus.js`) → reads return `{ ok:true, data, total? }`. ✅ conforms.
- **Errors everywhere** → `{ ok:false, error:"<string_code>", detail?:"..." }`. ⚠️ `error` is a **string**, not the `{code,message}` object in the target. This is the single most widespread deviation, but it is **internally consistent** across all bus-backed surfaces.
- **`/revenue`, `/channel`, `/platform` controllers** → use `{ ok:true, result }` for **both reads and writes** (`revenue.controller.js:11`, `channel.controller.js`, `platform.controller.js:7`). ⚠️ reads should use `data`.
- **Bespoke top-level keys** (not `data`/`result`): `auth` (bare fields), `settings` GET key (`value`), `files` (`file`), `connectors` (`connectors`/`config`), `webhooks` (`endpoints`), `notifications` (`notifications`/`notification`), `jobs` (`id`). See per-surface tables.

> The frontend absorbs all of the above through `utils/normalize.js` (`unwrap`/`asArray`/`asObject`).
> See the Normalization Dependency Report in the Phase 22 freeze doc.

### 1.4 Auth/permission failure codes
| Condition | Status | Body |
|---|---|---|
| No/expired bearer | 401 | `{ error:"<reason>" }` (frontend maps to `session_expired`) |
| Missing permission | 403 | via `requirePermission` |
| Missing tenant ctx | 400 | `{ ok:false, error:"tenant_required" }` |
| Command not registered | 400 | `{ ok:false, error:"command_not_registered" }` |
| Query not registered | 400 | `{ ok:false, error:"query_not_registered" }` |
| Business date locked | 400 | `{ ok:false, error:"business_date_locked" }` |
| Handler threw | 400 | `{ ok:false, error:"handler_threw", detail }` |

---

## 2. Health (`/api/health`) — public

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/api/health/live` | none | `{ status:"ok", uptimeSec }` |
| GET | `/api/health/ready` | none | `200 { db:"ok" }` / `503 { db:"down", error }` |

> Liveness/readiness probes. No envelope (intentional — consumed by orchestrator, not the SPA).

---

## 3. Auth (`/api/auth`)

| Method | Path | Auth | Permission | Request | Response (success) | Service backing |
|---|---|---|---|---|---|---|
| POST | `/login` | public (rate-limited 5/min/IP+user) | — | `{ tenant_code\|property_code, username, password, device_name?, device_id?, property_id? }` | `{ access_token, access_expires_at, refresh_token, refresh_expires_at, user, roles, permissions }` | `services/identity`, `services/tokens` |
| POST | `/refresh` | public | — | `{ refresh_token, device_name?, device_id? }` | `{ access_token, …, refresh_token, … }` | `tokens.rotateRefreshToken` |
| POST | `/logout` | bearer | — | `{ refresh_token? }` | `{ ok:true }` | `tokens.revokeRefreshToken` |
| GET | `/me` | bearer | — | — | `{ user, roles, permissions }` | `identity.resolveSession` |
| GET | `/properties` | bearer | — | — | `{ ok:true, data:[...] }` ✅ | `identityRepo.listAccessibleProperties` |
| POST | `/switch-property` | bearer | — | `{ property_id, device_name?, device_id? }` | `{ access_token, …, property_id }` | `identity.resolveSession` + `tokens` |
| POST | `/register` | bearer | `auth.user.create` (enforced in command) | user create payload | `{ ok, result }` | command `auth.user.create` |

> **Contract note:** `login`/`refresh`/`me`/`switch-property` return **bare top-level fields** (no `ok`/`data`). This is intentional and frozen — these are token-exchange endpoints, not domain reads. `/properties` already conforms to `{ ok, data }`.
> **Error shape:** `{ error:"<reason>" }` with 400/401/403 (e.g. `missing_fields`, `invalid_login_identifiers`, `property_access_denied`).

---

## 4. PMS (`/api/pms`)

Controller: `routes/pms.js`. Every read → `queryBus.execute`, every write → `commandBus.dispatch`.
Commands/queries: `commands/pms/*`, `queries/pms/*`.

### 4.1 Room types / buildings / floors
| Method | Path | Cmd/Query | Permission |
|---|---|---|---|
| GET | `/room-types` | `pms.roomtype.list` | `pms.roomtype.read` |
| GET | `/room-types/:id` | `pms.roomtype.byId` | `pms.roomtype.read` |
| POST | `/room-types` | `pms.roomtype.create` | `pms.roomtype.write` |
| POST | `/buildings` | `pms.building.create` | `pms.building.write` |
| POST | `/floors` | `pms.floor.create` | `pms.building.write` |

### 4.2 Rooms & features
| Method | Path | Cmd/Query | Permission |
|---|---|---|---|
| GET | `/rooms` | `pms.room.list` | `pms.room.read` |
| GET | `/rooms/number/:number` | `pms.room.byNumber` | `pms.room.read` |
| POST | `/rooms` | `pms.room.create` | `pms.room.write` |
| POST | `/rooms/:id/status` | `pms.room.status.change` | `pms.room.write` |
| POST | `/rooms/:id/activate` | `pms.room.activate` | `pms.room.write` |
| POST | `/rooms/:id/deactivate` | `pms.room.deactivate` | `pms.room.write` |
| GET | `/room-features` | `pms.feature.list` | `pms.feature.read` |
| POST | `/room-features` | `pms.feature.create` | `pms.feature.write` |
| POST | `/rooms/:id/features/:feature` | `pms.feature.attach` | `pms.feature.write` |

### 4.3 Guests & child policies
| Method | Path | Cmd/Query | Permission |
|---|---|---|---|
| GET | `/guests` | `pms.guest.list` | `pms.guest.read` |
| GET | `/guests/:id` | `pms.guest.byId` | `pms.guest.read` |
| POST | `/guests` | `pms.guest.create` | `pms.guest.write` |
| POST | `/guests/:id/blacklist` | `pms.guest.blacklist` | `pms.guest.write` |
| GET | `/child-policies` | `pms.childpolicy.list` | `pms.childpolicy.read` |
| GET | `/child-policies/:id` | `pms.childpolicy.byId` | `pms.childpolicy.read` |
| POST | `/child-policies` | `pms.childpolicy.create` | `pms.childpolicy.write` |

### 4.4 Reservations
| Method | Path | Cmd/Query | Permission |
|---|---|---|---|
| GET | `/reservations` | `pms.reservation.list` | `pms.reservation.read` |
| GET | `/reservations/number/:number` | `pms.reservation.byNumber` | `pms.reservation.read` |
| POST | `/reservations` | `pms.reservation.create` | `pms.reservation.write` |
| PUT | `/reservations/:id` | `pms.reservation.update` | `pms.reservation.write` |
| POST | `/reservations/:id/confirm` | `pms.reservation.confirm` | `pms.reservation.write` |
| POST | `/reservations/:id/cancel` | `pms.reservation.cancel` | `pms.reservation.write` |
| POST | `/reservations/:id/no-show` | `pms.reservation.noShow` | `pms.reservation.write` |
| POST | `/reservations/:id/room-move` | `pms.reservation.room_move` | `pms.reservation.write` |
| POST | `/reservations/:id/checkin` | `pms.reservation.checkin` | `pms.reservation.write` |
| POST | `/reservations/:id/check-in` *(alias)* | `pms.reservation.checkin` | `pms.reservation.write` |
| POST | `/reservations/:id/checkout` | `pms.reservation.checkout` | `pms.reservation.write` |
| POST | `/reservations/:id/check-out` *(alias)* | `pms.reservation.checkout` | `pms.reservation.write` |
| POST | `/reservations/:id/force-checkout` | `pms.reservation.checkout` (mode=FORCE) | `pms.reservation.write` |
| POST | `/reservations/:id/early-checkout` | `pms.reservation.checkout` (mode=EARLY) | `pms.reservation.write` |
| POST | `/reservations/:id/late-checkout` | `pms.reservation.checkout` (mode=LATE) | `pms.reservation.write` |

> **Alias note:** `check-in`/`check-out` (hyphenated) and the 3 checkout variants all map onto the same two commands; variants only tag the audit `mode`. See Dead/Duplicate Endpoint Report.

### 4.5 Front Desk lists
| Method | Path | Query | Permission |
|---|---|---|---|
| GET | `/frontdesk/arrivals` | `pms.frontdesk.arrivals` | `pms.reservation.read` |
| GET | `/frontdesk/departures` | `pms.frontdesk.departures` | `pms.reservation.read` |
| GET | `/frontdesk/inhouse` | `pms.frontdesk.inhouse` | `pms.reservation.read` |

### 4.6 Rate plans, meal plans
| Method | Path | Cmd/Query | Permission |
|---|---|---|---|
| GET | `/rate-plans` | `pms.rateplan.list` | `pms.rateplan.read` |
| GET | `/rate-plans/:id` | `pms.rateplan.byId` | `pms.rateplan.read` |
| POST | `/rate-plans` | `pms.rateplan.create` | `pms.rateplan.write` |
| POST | `/rate-plans/:id/meal-plan` | `pms.mealplan.attach_to_rateplan` | `pms.mealplan.write` |
| GET | `/meal-plans` | `pms.mealplan.list` | `pms.mealplan.read` |
| GET | `/meal-plans/:id` | `pms.mealplan.byId` | `pms.mealplan.read` |
| POST | `/meal-plans` | `pms.mealplan.create` | `pms.mealplan.write` |

### 4.7 Availability
| Method | Path | Query | Permission |
|---|---|---|---|
| GET | `/availability` | `pms.availability.byDate` | `pms.availability.read` |
| GET | `/availability/calendar` | `pms.availability.calendar` | `pms.availability.read` |

### 4.8 Folios, invoices, vouchers, payments
| Method | Path | Cmd/Query | Permission |
|---|---|---|---|
| GET | `/folios` | `pms.folio.list` | `folio.read` |
| GET | `/folios/:id` | `pms.folio.byId` | `folio.read` |
| POST | `/folios/:id/charges` | `pms.folio.charge.post` | `folio.post` |
| POST | `/folios/:id/close` | `pms.folio.close` | `folio.close` |
| POST | `/folios/:id/payments/cash` | `pms.folio.payment.cash` | `folio.post` |
| POST | `/folios/:id/payments/:pid/allocate` | `pms.folio.payment.allocate` | `folio.post` |
| GET | `/folios/:id/allocations` | `pms.folio.allocations.list` | `folio.allocate.read` |
| GET | `/invoices` | `pms.invoice.list` | `invoice.read` |
| GET | `/invoices/:id` | `pms.invoice.byId` | `invoice.read` |
| GET | `/invoices/number/:n` | `pms.invoice.byNumber` | `invoice.read` |
| POST | `/invoices/issue` | `pms.invoice.issue_from_folio` | `invoice.write` |
| POST | `/invoices/:id/void` | `pms.invoice.void` | `invoice.void` |
| POST | `/vouchers` | `pms.voucher.issue` | `voucher.write` |
| GET | `/vouchers/:n` | `pms.voucher.byNumber` | `voucher.read` |
| POST | `/vouchers/:n/redeem` | `pms.voucher.redeem` | `voucher.redeem` |
| POST | `/vouchers/:n/cancel` | `pms.voucher.cancel` | `voucher.write` |

### 4.9 Reservation groups
| Method | Path | Cmd/Query | Permission |
|---|---|---|---|
| POST | `/reservation-groups` | `pms.reservation_group.create` | `reservation.group.write` |
| GET | `/reservation-groups/:id` | `pms.reservation_group.byId` | `pms.reservation.read` |
| GET | `/reservation-groups/:id/rooming-list` | `pms.reservation_group.rooming_list` | `pms.reservation.read` |
| POST | `/reservation-groups/:id/rooms` | `pms.reservation_group.add_room` | `reservation.group.write` |
| POST | `/reservation-groups/:id/cancel-all` | `pms.reservation_group.cancel_all` | `reservation.group.write` |
| POST | `/reservation-groups/:id/checkin-all` | `pms.reservation_group.checkin_all` | `reservation.group.write` |

### 4.10 Housekeeping & night audit
| Method | Path | Cmd/Query | Permission |
|---|---|---|---|
| GET | `/housekeeping/tasks` | `pms.housekeeping.task.list` | `housekeeping.read` |
| GET | `/housekeeping/room-status` | `pms.housekeeping.room_status` | `housekeeping.read` |
| POST | `/housekeeping/tasks` | `pms.housekeeping.task.create` | `housekeeping.assign` |
| POST | `/housekeeping/tasks/:id/assign` | `pms.housekeeping.task.assign` | `housekeeping.assign` |
| POST | `/housekeeping/tasks/:id/complete` | `pms.housekeeping.task.complete` | `housekeeping.complete` |
| GET | `/night-audit/status` | `pms.night_audit.status` | `night_audit.read` |
| GET | `/night-audit/history` | `pms.night_audit.history` | `night_audit.read` |
| POST | `/night-audit/run` | `pms.night_audit.run` | `night_audit.run` |
| POST | `/night-audit/schedule` | `pms.night_audit.schedule` | `night_audit.config` |

---

## 5. Finance (`/api/finance`)

Controller: `routes/finance.js` (bus-backed; conforms to `data`/`result`).

| Method | Path | Cmd/Query | Permission |
|---|---|---|---|
| GET | `/cost-centers` | `finance.cost_center.list` | `cost_center.read` |
| GET | `/cost-centers/:id` | `finance.cost_center.byId` | `cost_center.read` |
| POST | `/cost-centers` | `finance.cost_center.create` | `cost_center.write` |
| PUT | `/cost-centers/:id` | `finance.cost_center.update` | `cost_center.write` |
| POST | `/cost-centers/:id/disable` | `finance.cost_center.disable` | `cost_center.write` |
| GET | `/revenue-map` | `finance.revenue_map.list` | `revenue_map.read` |
| POST | `/revenue-map` | `finance.revenue_map.upsert` | `revenue_map.write` |
| POST | `/revenue-map/delete` | `finance.revenue_map.delete` | `revenue_map.write` |
| POST | `/ledger/post` | `finance.ledger.post` | `ledger.write` |
| POST | `/ledger/validate` | `finance.ledger.validate` | `ledger.read` |
| POST | `/ledger/revert` | `finance.ledger.revert` | `ledger.revert` |
| GET | `/ledger/by-reference` | `finance.ledger.by_reference` | `ledger.read` |
| GET | `/ledger` *(alias of by-reference)* | `finance.ledger.by_reference` | `ledger.read` |
| GET | `/reports/cost-center` | `finance.cost_center.report` | `ledger.read` |
| GET | `/reports/revenue` | `finance.revenue.summary` | `ledger.read` |

> `POST /ledger/validate` is a **read** semantically but uses POST+`call` (returns `{ok,result}`); permission is `ledger.read`. Documented exception.

---

## 6. IAM (`/api/iam`) — read-only

| Method | Path | Query | Permission |
|---|---|---|---|
| GET | `/users` | `iam.users.list` | `auth.user.create` |
| GET | `/roles` | `iam.roles.list` | `auth.user.create` |

> User/role **mutation** is not exposed here; it stays on the `auth.user.create` command (`POST /api/auth/register`).

---

## 7. Channel Manager (`/api/channel`)

Controller: `channel-manager/api/channel.controller.js`. All responses `{ ok, result }` (incl. read).

| Method | Path | Controller | Permission |
|---|---|---|---|
| GET | `/status` | `c.status` | `channel.mapping.read` |
| POST | `/sync/rates` | `c.syncRates` | `channel.sync.run` |
| POST | `/sync/inventory` | `c.syncInventory` | `channel.sync.run` |
| POST | `/bookings/sync` | `c.syncBookings` | `channel.sync.run` |
| POST | `/bookings/confirm` | `c.confirmBooking` | `channel.sync.run` |
| POST | `/bookings/cancel` | `c.cancelBooking` | `channel.sync.run` |

> Graceful: router is empty unless `deps.channelManager` is wired.

---

## 8. Revenue Management (`/api/revenue`)

Controller: `revenue/api/revenue.controller.js`. All responses `{ ok, result }` (incl. read).

| Method | Path | Controller | Permission |
|---|---|---|---|
| GET | `/rate` | `c.getRate` | `revenue.snapshot.read` |
| GET | `/rate-grid` | `c.rateGrid` | `revenue.snapshot.read` |
| GET | `/forecast` | `c.forecast` | `revenue.snapshot.read` |
| GET | `/kpis` | `c.kpis` | `revenue.snapshot.read` |
| GET | `/dashboard` | `c.dashboard` | `revenue.snapshot.read` |
| POST | `/rate-plan` | `c.setRatePlan` | `revenue.snapshot.write` |
| POST | `/override` | `c.override` | `revenue.snapshot.write` |

> Graceful: router empty unless `deps.revenue` wired.

---

## 9. Platform / Admin (`/api/platform`)

Controller: `platform/api/platform.controller.js`. All responses `{ ok, result }` (incl. read).
Adds `platformMiddleware` (observability) ahead of handlers.

| Method | Path | Controller | Permission |
|---|---|---|---|
| GET | `/admin/metrics` | `c.metrics` | `bi.dashboard.read` |
| GET | `/admin/logs` | `c.logs` | `bi.dashboard.read` |
| GET | `/admin/audit` | `c.audit` | `bi.dashboard.read` |
| GET | `/integrations/status` | `c.integrationsStatus` | `bi.dashboard.read` |
| POST | `/integrations/webhook` | `c.webhook` | `channel.sync.run` |
| POST | `/integrations/sync` | `c.sync` | `channel.sync.run` |
| GET | `/enterprise/properties` | `c.properties` | `bi.dashboard.read` |
| GET | `/enterprise/analytics` | `c.analytics` | `bi.dashboard.read` |
| GET | `/enterprise/config` | `c.config` | `bi.dashboard.read` |

> Graceful: router empty unless `deps.platform` wired.

---

## 10. Platform infra surfaces (Phase 3) — not consumed by Stitch frontend

These exist and are protected, but the Stitch SPA does **not** currently call them.

### 10.1 Core dispatcher (`/api/core`)
| Method | Path | Response |
|---|---|---|
| POST | `/commands/:name` | generic command dispatch → `{ ok, result }` / `{ ok:false, error }` |
| GET | `/commands` | `{ commands:[...] }` (registry list) |
| ALL | `/*` | `501 { stub:true, ... }` |

> `POST /commands/:name` is the **generic escape hatch** that can dispatch any registered command, including ones with no dedicated REST route (e.g. `pms.allocation.create`). Treat as admin/internal.

### 10.2 Connector probe stubs (`/api/connector`, singular) — legacy
| Method | Path | Response |
|---|---|---|
| GET | `/:id/probe` | `{ id, configured:false, known, missing:['BACKEND_NOT_WIRED'], note }` |
| POST | `/:id/health` | `{ id, healthy:false, known, error:'not_configured', note }` |

> **Phase-1 stub.** Superseded in practice by `/api/connectors` (plural). See Dead/Duplicate Endpoint Report.

### 10.3 Connectors registry (`/api/connectors`, plural)
| Method | Path | Permission | Response key |
|---|---|---|---|
| GET | `/` | — | `connectors` |
| GET | `/:code/config` | `connector.configure` | `config` |
| PUT | `/:code/config` | `connector.configure` | `{ ok, ... }` |
| POST | `/:code/probe` | `connector.configure` | `{ ok, ... }` |
| POST | `/:code/health` | `connector.configure` | `{ ok, ... }` |

### 10.4 Settings (`/api/settings`)
| Method | Path | Permission | Response key |
|---|---|---|---|
| GET | `/schema` | `settings.schema.read` | `data` ✅ |
| GET | `/schema/:category/:key` | `settings.schema.read` | `data` ✅ |
| GET | `/:category` | `settings.read` | `data` ✅ |
| GET | `/:category/:key` | `settings.read` | **`value`** ⚠️ |
| PUT | `/:category/:key` | `settings.write` | `{ ok, ... }` |
| DELETE | `/:category/:key` | `settings.write` | `{ ok, ... }` |

### 10.5 Files (`/api/files`)
| Method | Path | Permission | Response key |
|---|---|---|---|
| POST | `/` | `files.upload` | `file` (201) |
| GET | `/:id` | `files.read` | `file` |
| GET | `/:id/token` | `files.read` | `token`, `expires_in_sec` |
| GET | `/:id/download` | token or bearer | binary stream |
| DELETE | `/:id` | `files.delete` | `{ ok, ... }` |

### 10.6 Webhooks (`/api/webhooks`)
| Method | Path | Permission | Response key |
|---|---|---|---|
| GET | `/` | `webhook.manage` | `endpoints` |
| POST | `/` | `webhook.manage` | `{ ok, ... }` (201) |
| DELETE | `/:id` | `webhook.manage` | `{ ok, ... }` |
| POST | `/deliveries/run` | `webhook.manage` | `{ ok, ... }` |

### 10.7 Jobs (`/api/jobs`)
| Method | Path | Permission | Response key |
|---|---|---|---|
| POST | `/` | `jobs.schedule` | `id` (201) |
| DELETE | `/:id` | `jobs.schedule` | `{ ok, ... }` |
| POST | `/run` | `jobs.schedule` | `{ ok, ... }` |

### 10.8 Notifications (`/api/notifications`)
| Method | Path | Permission | Response key |
|---|---|---|---|
| POST | `/` | `notifications.send` | `{ ok, ... }` (201) |
| GET | `/` | `notifications.read` | `notifications` |
| GET | `/:id` | `notifications.read` | `notification` |
| POST | `/send/run` | `notifications.send` | `{ ok, ... }` |

---

## 11. Modules referenced in Phase 22 scope but NOT present as API surfaces

| Scope item | Status |
|---|---|
| CRM | **Not present** — no module, route, or command. |
| Procurement | **Not present.** |
| HR / Payroll | **Not present.** |
| Inventory | Present **internally only** (`pms/inventory/*`: `RoomInventoryEngine`, `AvailabilityCalculator`, `OccupancyTracker`). Exposed indirectly via `/api/pms/availability*`. No standalone `/inventory` API. |
| Multi-Property | Exposed via `/api/auth/properties`, `/api/auth/switch-property`, and `/api/platform/enterprise/properties`. No dedicated `/properties` CRUD surface. |

---

## 12. Authentication & permission standards (summary)

- **Transport:** Bearer JWT (access token) on every `/api/*` except health and the public auth endpoints.
- **Refresh:** rotating refresh tokens (`/api/auth/refresh`), device-bound.
- **Multi-property scoping:** access token carries `primaryPropertyId`; `/switch-property` re-issues a scoped pair after server-side re-validation.
- **Authorization:** declarative `requirePermission('<perm>')` at the route, plus a second enforcement inside accounting-sensitive commands. Permission codes are seeded in migration `0030` and resolved into the session at login.
- **Audit:** every command dispatch (success or denial) writes an immutable `audit_events` row via the command bus pipeline.
