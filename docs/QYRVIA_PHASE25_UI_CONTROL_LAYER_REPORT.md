# QYRVIA Phase 25 — UI Control Layer — Implementation & Validation Report

**Scope:** Add a UI **Control Center** that surfaces the Channel Manager / OTA + persistence
subsystems' operational status, backed by an additive non-secret endpoint; perform the legacy-UI
footprint audit; keep a single unified QYRVIA experience.

---

## 1. Legacy-footprint audit (UI governance rule)

A repo-wide scan of `frontend-stitch` for `V24`, `V30`, `GreenKey`/`Green Key`, deprecated menus,
duplicate dashboards, legacy routes, and unused assets:

| Footprint class | Found | Action |
|---|---|---|
| V24 references | **0** | none |
| V30 references | **0** | none |
| GreenKey branding remnants | **0** | none |
| Deprecated menus | **0** | none |
| Duplicate dashboards | **0** | none |
| Legacy routes | **0** | none |
| Unused / obsolete assets | **0** | none |
| Hidden legacy modules | **0** | none |

**Finding:** `frontend-stitch` is the clean Phase-19 QYRVIA replacement SPA; it carries **no legacy
footprints**. The only `legacy` string in the codebase is a code comment in `apiClient.js` describing
the legacy *error envelope* shape (not a UI artifact). The UI already presents a single unified QYRVIA
experience — **nothing to remove.**

## 2. Files

**Created**
- `server/src/channel-manager/api/controlSnapshot.js` — non-secret operational snapshot builder
- `frontend-stitch/src/modules/control/Control.view.js` — Control Center view
- `server/test/channelControlSnapshot.test.js` — 4 backend tests
- `docs/QYRVIA_PHASE25_UI_CONTROL_LAYER_REPORT.md` — this report

**Modified**
- `server/src/channel-manager/api/channel.routes.js` — additive `GET /api/channel/control` (RBAC `channel.mapping.read`)
- `frontend-stitch/src/services/index.js` — `services.channel.control()`
- `frontend-stitch/src/app/routes.js` — nav route `/control` (section System)
- `frontend-stitch/src/app/app.js` — `ControlView` wired into the view map
- `frontend-stitch/test/services.test.js` — assert `GET /channel/control`

No PMS / OTA-connectivity / worker / queue / credential-store / schema changes. No legacy removal
(none existed).

## 3. Screen inventory (before → after)

> Note: textual screen/route inventory (the SPA was not launched in a browser, so no pixel captures
> were produced). Nav is RBAC-gated; sections render per `routes.js`.

| Section | Before | After |
|---|---|---|
| Overview | Dashboard | Dashboard |
| Front Office | Reservations, Front Desk, Guests | (unchanged) |
| Inventory & Rates | Rooms, Availability, Rate Plans | (unchanged) |
| Revenue & Billing | Revenue, Billing | (unchanged) |
| Operations | Housekeeping, Night Audit, Channel Manager | (unchanged) |
| Finance | Accounting | (unchanged) |
| **System** | Platform Admin | **Control Center (NEW)**, Platform Admin |

**Control Center screen (new):** subsystem-status grid (persistence mode, credential-provider
presence, worker / webhook / real-OTA-HTTP flags, real-sync channels, live HTTP channels, mapped
room-type count) + channels & queue table (queue size, dead-letter, bookings tracked) + manual sync
triggers (rates / inventory / bookings, gated by `channel.sync.run`) + refresh.

## 4. Route inventory

### 4.1 Frontend nav routes (after)
`/login` (public), `/dashboard`, `/reservations`, `/frontdesk`, `/guests`, `/rooms`, `/availability`,
`/rateplans`, `/revenue`, `/billing`, `/housekeeping`, `/nightaudit`, `/channel`, `/finance`,
**`/control` (NEW)**, `/admin`.

### 4.2 Backend API routes touched
| Route | Method | Status | RBAC |
|---|---|---|---|
| `/api/channel/control` | GET | **NEW (additive)** | `channel.mapping.read` |
| (all other `/api/channel/*`, `/api/*`) | — | unchanged | — |

### 4.3 Removed legacy route inventory
**None.** No legacy routes existed in the SPA or the API surface (§1).

## 5. Validation

| Suite | Before | After |
|---|---|---|
| Backend `npm test` | 569 / 0 / 3 (572) | **573 / 0 / 3 (576)** (+4) |
| Frontend `npm test` | 28 / 0 | **28 / 0** (assertions added in-place; `GET /channel/control` mapped) |

**Backend tests added (4):** snapshot aggregates non-secret status · snapshot never exposes
secrets/credential payloads · resilient to missing subsystems (graceful partial) · flags reflect env.

**Frontend:** `services map to existing backend routes` now asserts `GET /channel/control`; `every
service path targets a known mounted prefix` still passes (`/channel/` is an allowed prefix) — no
prefix-contract change required.

## 6. Regression summary
- **Zero regressions.** Backend grew +4 (additive); frontend count unchanged with added assertions.
- **Default runtime unchanged:** the new endpoint is read-only and returns metadata only; the Control
  Center consumes existing sync actions; all P24 subsystems remain default-off.
- **No secret exposure:** the snapshot returns only presence flags/counts/modes — proven by the
  "never exposes secrets" test (credential payloads excluded).
- PMS / OTA connectivity / worker / queue / webhook / credential store / schema: **untouched.**

## 7. Constraints honored
✅ Single unified QYRVIA branding (no legacy footprints existed) · ✅ Additive API (one read-only
endpoint) · ✅ No schema changes · ✅ No PMS/OTA/worker changes · ✅ Backend + frontend suites green.

## 8. Notes / deferred
- A **direct-booking product screen** (consuming the Booking Engine) was **not** included here — it
  requires a new write endpoint + permission and is a distinct product feature; recommended as its own
  phase. This Phase 25 delivers the **observability/control** layer.

**STOP after implementation & validation. Do not begin the AI WhatsApp Agent. Await approval.**
