# QYRVIA ERP — Deployment Preparation (Phase 42)

**Status: preparation only. Nothing in this directory deploys, publishes, or configures live hosting.**

These are hosting-provider-neutral runbooks and checklists to make a future
**Phase 43** deployment safe and repeatable. They contain **placeholders only** —
no real secrets, database URLs, hostnames, DNS, or production config.

## Contents

| Doc | Purpose |
|---|---|
| [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md) | Step-by-step build → env → DB → start → health, hosting-neutral |
| [PRODUCTION_READINESS_CHECKLIST.md](PRODUCTION_READINESS_CHECKLIST.md) | Go/no-go gates: secrets, DB, RLS, monitoring, logging, backup, security |
| [SMOKE_TEST_CHECKLIST.md](SMOKE_TEST_CHECKLIST.md) | Non-secret post-deploy smoke steps (static + live authenticated browser) |
| [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md) | How to revert a bad release safely |
| [PHASE43_HANDOFF.md](PHASE43_HANDOFF.md) | Actionable handoff for whoever runs the actual deploy |

## System shape (as-built, `main` @ Phase 40)

- **Backend:** Node.js service, entry `server/src/index.js` (`npm start`). Fails fast
  at boot if `DATABASE_URL` or `JWT_SECRET` is missing. Listens on `PORT` (default `3001`).
- **Database:** PostgreSQL. Multi-tenant isolation is **RLS-enforced** (see the CI `db`
  job and `server/scripts/rls-preflight.js`). Migrations: `npm run migrate`.
- **Frontend:** `QYRVIA_ERP_V35-1.html` — a single, self-contained static HTML file.
  It is **not** served by the backend; host it on any static host/CDN and point its
  relative `/api/...` calls at the backend origin (reverse proxy or same origin).
- **Health:** `GET /api/health/live` (liveness) and `GET /api/health/ready`
  (readiness — pings the DB; `200 {db:ok}` / `503 {db:down}`).
- **CI:** `.github/workflows/ci.yml` — `unit` (in-memory), `db` (real Postgres, RLS-aware),
  `frontend` jobs.

## Hard boundaries (Phase 42)

Do **not**, in this phase: deploy/publish/preview-deploy, change DNS or qyrvia.com,
configure production hosting, contact production systems, or add/print/commit real
secrets. Those belong to Phase 43 and are gated by the checklists here.
