# Phase 43 Handoff — Publish/Deploy to Web

Phase 42 produced **preparation artifacts only**. Nothing has been deployed, no DNS
or qyrvia.com config changed, no production system contacted, and no real secret exists
in the repo. Phase 43 owns the actual deploy.

## What is ready (from Phase 42)
- Hosting-neutral `DEPLOYMENT_RUNBOOK.md` (build → env → DB → start → health → serve UI).
- `PRODUCTION_READINESS_CHECKLIST.md` with the **complete env-var reference** and gates.
- `SMOKE_TEST_CHECKLIST.md` (incl. the live authenticated browser pass Phase 41 deferred).
- `ROLLBACK_PLAN.md`.
- `server/.env.example` completed with **placeholders** for all supported variables.

## What Phase 43 must decide / provide (NOT in this repo)
- [ ] Target hosting platform(s) for the **backend** (container/runtime) and the **static UI**.
- [ ] Production **PostgreSQL** instance + the RLS-scoped app role credentials.
- [ ] Real secret values in the platform secret store: `DATABASE_URL`, `JWT_SECRET`,
      `CHANNEL_CREDENTIAL_KEY` (if the credential vault is used). **Never commit these.**
- [ ] TLS/HTTPS termination and the `/api` routing between the static UI origin and backend.
- [ ] DNS / qyrvia.com records (Phase 43 only).
- [ ] Backups, monitoring, and alerting wired to the platform.

## Recommended Phase 43 sequence
1. Provision DB → `db:provision` → `migrate` → `db:preflight` (must pass).
2. Deploy backend with production env; confirm `/api/health/ready` = 200.
3. Publish `QYRVIA_ERP_V35-1.html`; wire `/api` to the backend origin.
4. Run `SMOKE_TEST_CHECKLIST.md` A → B → C (live authenticated browser).
5. Configure DNS/qyrvia.com **last**, after smoke passes on a staging origin.
6. Keep all feature flags at safe defaults (`CHANNEL_HTTP_ENABLED=false`, `AI_*=false`)
   unless a dedicated, reviewed phase enables them.

## Explicit non-goals carried forward
No live OTA transport, no payment gateway, no schema/RLS/auth/behavior changes as part
of deployment. Any such change is its own reviewed work item, not a deploy step.
