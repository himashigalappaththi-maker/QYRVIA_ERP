# QYRVIA Stitch UI (`frontend-stitch`)

The replacement frontend for QYRVIA — a **dumb, API-consumer visualization
layer** built on the Stitch design system. The backend (Phases 11–18) is the
system of record and is **not modified** by this frontend.

## Design

- **Stitch "Functional Luxury"** tokens: gold `#775a19` / charcoal / slate,
  Hanken Grotesk (display) + Inter (body), Material Symbols, soft 12/16px radii.
- **Tailwind via CDN** (no build step) — config embedded in `index.html`.
- Modern SaaS layout: charcoal sidebar with gold active indicator, top bar,
  card-based content, responsive (desktop-first).

## Stack (intentionally build-free)

Vanilla **ES modules** — no React/bundler/toolchain. This keeps the UI a thin
consumer, runnable by serving the folder, with the cross-cutting logic
unit-testable in Node.

## Structure

```
src/
  app/        app bootstrap + router (pure decide() + DOM wiring) + routes (sectioned nav)
  services/   apiClient (the only backend gateway) + per-domain services (every path = a real backend route)
  store/      session (token + expiry + property context)
  utils/      rbac (real-permission UX hiding), normalize (data/result envelopes), dom, format
  hooks/      useApi (load/loading/error)
  components/ Layout, Sidebar, Topbar, PropertySwitcher, overlay (modal/drawer), ui, Toast
  modules/    auth, dashboard, reservations, frontdesk (+logic/shared), guests, rooms,
              availability, rateplans, revenue, billing, housekeeping, nightaudit,
              channel, finance, platform-admin
  styles/     theme.css
```

## Phase 20A — production migration (frontend-only)

This UI now consumes the **real** backend surface (Phases 11–18) — no backend,
schema, API or business-logic changes. Highlights:

- **Live data everywhere.** All screens call existing `/api/*` routes; placeholder
  and mock content is removed. Response envelopes are normalized (`/pms` & `/finance`
  return `{data}`; `/revenue`, `/platform`, `/channel` return `{result}`).
- **RBAC aligned to the backend.** The login `permissions[]` array is authoritative
  for UX hiding; `super_admin`/`corporate_admin`/`property_admin` bypass mirrors the
  server. Nav + route guards use real permission codes (e.g. `pms.reservation.read`,
  `invoice.read`, `cost_center.read`). The backend still authorizes every call.
- **Multi-property context** preserved via the topbar switcher
  (`GET /auth/properties` + `POST /auth/switch-property`, re-scoped tokens).
- **Honest degradation.** Where the backend exposes a write but no list read
  (folios, housekeeping tasks, night-audit status), the screen states this and is
  keyed by id / sourced from the audit stream — no fabricated data.

See `docs/QYRVIA_P20A_FRONTEND_MIGRATION.md` for the per-module migration report.

## Run locally

```bash
cd frontend-stitch
node scripts/serve.js        # http://localhost:5180, proxies /api -> :3001
# (start the backend separately: cd server && npm start)
```

Open `http://localhost:5180`, sign in at `/login`. The dev server proxies
`/api/*` to the QYRVIA backend so the SPA calls the real endpoints.

## Auth & RBAC

- Login via `POST /api/auth/login`; the JWT/session is stored and attached as
  `Authorization: Bearer <token>` on every request (`apiClient`).
- `401` → session cleared + redirect to `/login`; `403` → graceful "no access".
- Navigation/routes are RBAC-filtered for UX only — **the backend remains the
  source of truth** and every call is still server-side authorized.

## Tests

```bash
npm test     # node --test on the pure logic (apiClient, session, rbac, router)
```

Covers the required cases: login/session handling, role-based navigation,
API error handling (401/403), session expiry, module access control, and
routing correctness. Runs in CI (`frontend` job) — no DB, no install.

## Migration strategy

- **A (Parallel):** keep the legacy UI; serve this at `/stitch-ui`.
- **B (Integration):** connect every module to the live APIs, validate flows.
- **C (Cutover):** make this the root UI, archive the legacy `QYRVIA_ERP_V35-1.html`.

## Endpoint note

`/api/auth`, `/api/revenue`, `/api/platform/*` (and `/api/pms`, `/api/finance`,
`/api/channel`) are live on the backend today. The front-desk/billing/
housekeeping/night-audit screens target the documented contract endpoints; where
a backend HTTP route isn't yet exposed those screens degrade gracefully (empty/
error state) — by design, since the frontend must not add backend logic.
