# QYRVIA Phase 19 — Stitch UI Frontend Replacement

> Replaces the legacy single-file UI with a new Stitch design-system frontend at
> `/frontend-stitch`. **Strictly a frontend + API-integration task — the backend
> (Phases 11–18) is not modified, no schema changes, no business logic in the
> frontend.** The frontend is a dumb visualization layer; the backend is the
> system of truth.

## Approach

- **Stitch design system** (from the provided design assets): gold `#775a19` /
  charcoal / slate palette, Hanken Grotesk + Inter, Material Symbols, Tailwind.
- **Build-free vanilla ES modules** — no React/bundler. This keeps the UI a thin
  API consumer and makes the cross-cutting logic unit-testable in Node (which
  CI runs), avoiding a toolchain that the rest of the repo doesn't use.

## What was delivered (`frontend-stitch/`)

- **Core infra:** `apiClient` (the sole backend gateway — JWT attach, 401
  session-expiry, 403 forbidden, error normalization), `session` store (token +
  expiry), `rbac` (UX nav/route hiding mirroring backend roles), `router`
  (pure `decide()` + DOM wiring), `routes` table.
- **Shell + components:** Layout (sidebar + topbar + outlet), Sidebar (charcoal
  + gold active bar, RBAC-filtered), Topbar, reusable `ui` (cards/KPI/table/
  status badges/buttons), Toast, `useApi` loader.
- **Modules:** auth (login), dashboard, front desk (stays + check-out), billing
  (folios + invoices), housekeeping (task board), revenue (KPIs + pricing
  calendar), night audit (business-date status + run + history), platform admin
  (metrics + integrations + properties + audit stream).
- **Dev server** (`scripts/serve.js`) that statically serves the SPA and proxies
  `/api/*` to the backend.

## Authentication & RBAC

- Login → `POST /api/auth/login`; JWT stored and attached to every request.
- Session expiry handled centrally: `401` clears the session and redirects to
  `/login`; `403` shows a graceful "no access" state.
- Navigation and routes are RBAC-filtered for UX, but the **backend authorizes
  every call** — the frontend never assumes permissions.

## Routing

`/login`, `/dashboard`, `/frontdesk`, `/billing`, `/housekeeping`, `/revenue`,
`/nightaudit`, `/admin` (hash routing; unauthorized → redirect).

## API integration (REST only, no direct DB, no duplicated logic)

`/api/auth/*`, `/api/platform/*`, `/api/revenue/*` are live today; the
front-desk/billing/housekeeping/night-audit screens target the documented
contract and degrade gracefully where a backend HTTP route isn't yet exposed
(the frontend must not add backend routes/logic).

## Tests (`frontend-stitch/test`, run in the CI `frontend` job)

- `apiClient` — token attach, query building, 401 (clears session + callback),
  403 callback, backend error surfacing.
- `session` — save/load/clear, expiry, authentication state.
- `rbac` — role permissions/wildcards/deny-by-default, nav filtering, route access.
- `router` — unknown→redirect, login-bounce-when-authed, auth+permission gating.

All 15 pass. CI adds a third job (`frontend`) with no DB and no install.

## Fidelity pass (aligned to the Stitch `code.html` mockup)

- Brand assets copied into `frontend-stitch/assets/` (`qyrvia-logo.png`,
  `ai-assistant.png`) and used in the sidebar + assistant launcher.
- Shell aligned to the mockup: branded 280px charcoal sidebar with gold active
  bar + filled active icon, top bar with notifications/help + profile, and a
  responsive **mobile bottom nav** (desktop-first; sidebar `lg:` only).
- **AI assistant launcher** uses the brand avatar but is honest — it states no
  AI backend is wired in this build rather than faking responses (consistent
  with the platform "no fake AI" rule); it becomes the assistant surface once an
  endpoint exists.

## Migration strategy

A (parallel run at `/stitch-ui`) → B (full API integration + flow validation) →
C (cutover to root, archive legacy `QYRVIA_ERP_V35-1.html`).

## Constraints honored

No backend code/schema/business-logic changes; no RBAC/auth bypass; REST-only;
the frontend is a pure consumer. Server CI (unit + DB) remains green; a new
frontend CI job verifies the UI logic.
