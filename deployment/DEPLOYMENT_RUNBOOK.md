# Deployment Runbook (hosting-neutral)

Steps to stand up QYRVIA ERP in a new environment. **Placeholders only** — substitute
real values from your secret manager at deploy time; never commit them.

Prerequisites: Node.js 22 (matches CI), a reachable PostgreSQL 16 instance, and a
static host/CDN (or reverse proxy) for the UI.

## 1. Get the code
```
git clone <repo-url> && cd QYRVIA_ERP
git checkout <release-tag-or-main>
```

## 2. Install backend dependencies
```
cd server
npm ci            # reproducible install from package-lock.json
```

## 3. Configure environment (secrets from your secret manager — NOT committed)
Copy the template and fill in real values in the deploy environment only:
```
cp .env.example .env    # then set real values via the platform's secret store
```
REQUIRED (boot fails without these): `DATABASE_URL`, `JWT_SECRET` (>= 32 chars).
Generate a JWT secret: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
See `PRODUCTION_READINESS_CHECKLIST.md` for the full variable reference, and
`server/.env.example` for every supported key with safe defaults.

For the Phase 40 credential vault, set `CHANNEL_CREDENTIAL_KEY` to a 32-byte key
(`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) so
channel credentials encrypt at rest. Leave OTA/network flags at their safe defaults
(`CHANNEL_HTTP_ENABLED=false`) unless a later phase explicitly enables live OTA.

## 4. Provision the database (RLS-aware)
The suite and app run as a **non-superuser** role (RLS is FORCE-enabled; a superuser
bypasses RLS). Mirror the CI approach:
```
# one-time: create the restricted app role (superuser URL used ONLY here)
SUPERUSER_DATABASE_URL=<placeholder> APP_ROLE=<placeholder> APP_ROLE_PASSWORD=<placeholder> \
  npm run db:provision
# apply the migration chain as the app role
npm run migrate
# gate: refuse to proceed if superuser/BYPASSRLS, missing FORCE RLS, or a cross-tenant leak
npm run db:preflight
```

## 5. Start the backend
```
npm start          # node src/index.js, listens on $PORT (default 3001)
```
Run under a process manager / container with restart-on-failure. Health probes:
- Liveness:  `GET /api/health/live`
- Readiness: `GET /api/health/ready`  (200 `{db:ok}` when the DB is reachable)

## 6. Serve the frontend
`QYRVIA_ERP_V35-1.html` is a self-contained static file. Publish it to a static host
or reverse proxy, and ensure its relative `/api/...` requests reach the backend origin
(same origin or a proxy rule). No build step is required for the UI.

## 7. Post-deploy verification
Run `SMOKE_TEST_CHECKLIST.md`. If anything fails, follow `ROLLBACK_PLAN.md`.

## Notes
- Feature flags default OFF/safe: `CHANNEL_HTTP_ENABLED=false`, `CHANNEL_WORKER_ENABLED=false`,
  `CHANNEL_WEBHOOK_ENABLED=false`, `AI_AGENT_ENABLED=false`, `AI_LLM_ENABLED=false`,
  `AI_CONFIRMATION_ENABLED=false`. Enable only per an explicit, reviewed phase.
- `CHANNEL_PERSISTENCE=memory` is the default; use a durable mode for production once
  the corresponding infra is provisioned.
