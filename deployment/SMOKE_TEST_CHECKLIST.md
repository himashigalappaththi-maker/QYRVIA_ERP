# Smoke Test Checklist (non-secret)

Run after a Phase 43 deploy (or in any environment with the backend + a browser).
No secrets required. Record pass/fail; on failure see `ROLLBACK_PLAN.md`.

## A. Infra / backend health
- [ ] `GET /api/health/live` → 200.
- [ ] `GET /api/health/ready` → 200 `{db:ok}` (DB reachable).
- [ ] Backend boots with REQUIRED env set; refuses to boot if `DATABASE_URL`/`JWT_SECRET` missing (expected).

## B. Static / handler validation (runnable without a browser)
- [ ] `cd server && npm run test:unit` → all green.
- [ ] V35 inline JS syntax check passes (all `<script>` blocks parse).
- [ ] `npm run test:db:guarded` green on a parity Postgres.

## C. Live authenticated browser smoke (Phase 43 — REQUIRED before pilot sign-off)
> This is the step Phase 41 could not execute locally (no DB/secrets/browser tooling).
> Perform it against the running backend with a real authenticated session.

Load & navigation
- [ ] `QYRVIA_ERP_V35-1.html` loads with **no startup console errors**.
- [ ] Main navigation works; Dashboard loads; Rooms and Channel Manager pages open.

Booking Engine public sales flow (Rooms page)
- [ ] Search form renders (dates / guests / room type).
- [ ] Availability check shows available / **fail-closed unavailable** / API-unavailable safely.
- [ ] Booking summary renders before submit.
- [ ] Submit button disables while pending; **duplicate submit prevented**.
- [ ] Confirmation renders on success; **user-safe error** on failure (no stack trace).

Channel Ops tab
- [ ] Test Connection shows ready/not-ready with `mode:sandbox` / `probe:readiness_only`, or safe API-unavailable.
- [ ] Sync Health renders metrics or safe empty/API-unavailable.
- [ ] DLQ renders **metadata-only** (no `payload_json`) or empty state; reprocess labelled **request-only**.
- [ ] Credential card: save succeeds; **secret input clears after save**; secret **never re-rendered**.
- [ ] Mapping card: save/list handle success/error safely.

## D. Security spot-check (DOM + console + network)
- [ ] No secrets / API keys / tokens / passwords rendered in the DOM or console.
- [ ] No `payload_json`, guest payload, or payment payload rendered.
- [ ] No stack traces surfaced to the user.
- [ ] No live-OTA/certification wording; `CHANNEL_HTTP_ENABLED` remains `false`.
