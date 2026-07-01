# RBAC & Multi-Property Visibility Audit (Phase 35)

## Model
Client RBAC (`frontend-stitch/src/utils/rbac.js`) is **UX hiding only**; the
backend stays the source of truth. Every API call is still authorized server-side
and 401/403 is handled centrally (`apiClient` → `onUnauthorized`/`onForbidden`).

Authorization precedence in `can(principal, permission)`:
1. `super_admin` / `corporate_admin` / `property_admin` → allow-all (mirrors backend bypass).
2. `principal.permissions[]` (authoritative, from `/auth/me` / login) with glob match (`pms.*`).
3. Role→permission glob fallback for principals issued without an explicit permissions array.
4. Deny by default.

## Nav-permission alignment (routes.js gate vs backend guard)

| Route | Nav permission | Backend route guard | Aligned? |
|---|---|---|---|
| /booking | `pms.reservation.write` | `/booking/*` → `pms.reservation.write` | ✅ |
| /reservations | `pms.reservation.read` | `/pms/reservations` GET → `pms.reservation.read` | ✅ |
| /frontdesk | `pms.reservation.read` | frontdesk reads → `pms.reservation.read` | ✅ |
| /guests | `pms.guest.read` | `/pms/guests` → `pms.guest.read` | ✅ |
| /rooms | `pms.room.read` | `/pms/rooms` → `pms.room.read` | ✅ |
| /availability | `pms.availability.read` | `/pms/availability` → `pms.availability.read` | ✅ |
| /rateplans | `pms.rateplan.read` | `/pms/rate-plans` → `pms.rateplan.read` | ✅ |
| /revenue | `revenue.snapshot.read` | `/revenue/*` reads → `revenue.snapshot.read` | ✅ |
| /billing | `invoice.read` | `/pms/invoices` → `invoice.read` | ✅ |
| /housekeeping | `housekeeping.read` | housekeeping reads → `housekeeping.read` | ✅ |
| /nightaudit | `night_audit.read` | night-audit reads → `night_audit.read` | ✅ |
| /channel | `channel.mapping.read` | `/channel/status` → `channel.mapping.read` | ✅ |
| /finance | `cost_center.read` | `/finance/cost-centers` → `cost_center.read` | ✅ |
| /control | `channel.mapping.read` | `/channel/control` → `channel.mapping.read` | ✅ |
| /admin | `bi.dashboard.read` | `/platform/*` → `bi.dashboard.read` | ✅ |
| /dashboard | none | (aggregates of guarded reads) | ✅ |

**All nav gates match the read permission of the primary backend route they open.**
No route is over- or under-exposed at the nav layer.

## Intra-screen action gates (write permissions)
Views call write endpoints (e.g. `reservations.checkIn` → `pms.reservation.write`,
`billing.postCharge` → `folio.post`) that are guarded server-side. Note the client
nav gate uses the *read* permission, so a read-only user can open a screen but
write actions will 403 server-side and surface via the central `onForbidden` toast.
**Recommendation (UI polish, not a security gap):** hide/disable write controls
client-side using `can(principal, '<write perm>')` for cleaner UX during Stitch
migration. The Finance view already requires `cost_center.read` to open but exposes
create/disable controls that need `cost_center.write` — these will 403 for a
read-only accountant.

## Multi-property behavior
- `PropertySwitcher.js` is wired: `auth.properties()` (`GET /auth/properties`) lists
  accessible properties; `auth.switchProperty(id)` (`POST /auth/switch-property`)
  rebinds context. Backend `identityContext` honors `X-Property-Id` only when the
  user is assigned to it (`canAccessProperty`), fail-closed. ✅
- Property scope flows to every PMS/finance read via the bound context; RLS tenant
  isolation + application property check (Phase 31.5) enforce it server-side.
- **Gap:** no per-screen "current property" indicator audit was possible without
  runtime; switcher presence + backend enforcement confirmed statically. ✅ adequate.

## Verdict
RBAC nav visibility is correctly aligned and deny-by-default. Multi-property
switching is wired and backend-enforced. The only follow-up is **client-side
write-control gating** for polish (server already enforces).
