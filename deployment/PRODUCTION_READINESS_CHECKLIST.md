# Production Readiness Checklist

Go/no-go gates before a Phase 43 deploy. Check every box or record an accepted
exception. **Placeholders only** below — never paste real secrets into this file.

## 1. Environment variable reference

REQUIRED (boot fails fast if missing — `server/src/config/env.js`):

| Var | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL URI. Point at the RLS-scoped **app role**, not a superuser. |
| `JWT_SECRET` | >= 32 chars, high-entropy, from the secret manager. |

OPTIONAL (safe defaults shown; override only with intent):

| Var | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | set `production` for a prod deploy |
| `PORT` | `3001` | listen port |
| `LOG_LEVEL` | `info` | pino level |
| `JWT_SECRET_PREV` | `` | set during secret rotation, then unset |
| `ACCESS_TOKEN_TTL_SEC` | `900` | |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | |
| `BCRYPT_ROUNDS` | `12` | |
| `ERROR_ENVELOPE` | `string` | |
| `DB_OBSERVABILITY` | `true` | |
| `CHANNEL_PERSISTENCE` | `memory` | use a durable store for prod |
| `CHANNEL_CREDENTIAL_KEY` | `` | **32-byte key** for at-rest channel credential encryption (Phase 40). Without it the credential vault is dormant. |
| `CHANNEL_WORKER_ENABLED` | `false` | keep off until infra reviewed |
| `CHANNEL_WEBHOOK_ENABLED` | `false` | |
| `CHANNEL_HTTP_ENABLED` | `false` | **live OTA transport — keep `false`; do not enable outside an approved OTA phase** |
| `CHANNEL_REALSYNC_CHANNELS` | `QTCN` | internal channel only by default |
| `CHANNEL_OTA_ACTIVATIONS` | `` | leave empty (no live OTA) |
| `CHANNEL_CANONICAL_CORE` | `true` | |
| `AI_AGENT_ENABLED` | `false` | |
| `AI_LLM_ENABLED` | `false` | keep off; no vendor HTTP until reviewed |
| `AI_CONFIRMATION_ENABLED` | `false` | |

## 2. Secrets checklist (placeholder names only — never real values)
- [ ] `DATABASE_URL` provisioned in the platform secret store.
- [ ] `JWT_SECRET` generated (48 random bytes) and stored; **not** in git.
- [ ] `CHANNEL_CREDENTIAL_KEY` generated (32 bytes) if the credential vault is used.
- [ ] Secret rotation procedure documented (`JWT_SECRET` → `JWT_SECRET_PREV` window).
- [ ] `.env` confirmed gitignored; no secret appears in the repo or CI logs.

## 3. Database preparation
- [ ] PostgreSQL 16 instance reachable from the backend.
- [ ] Restricted **app role** created (non-superuser, not BYPASSRLS) — `npm run db:provision`.
- [ ] Migration chain applied cleanly — `npm run migrate`.
- [ ] RLS preflight passes — `npm run db:preflight` (fails on superuser/BYPASSRLS,
      missing FORCE RLS, PUBLIC UPDATE/DELETE on append-only tables, or cross-tenant leak).
- [ ] Connection pool sizing reviewed for the target load.

## 4. Security / isolation gates
- [ ] App connects as the RLS-scoped role (verified by `db:preflight`).
- [ ] Multi-tenant + property isolation unchanged (RLS + app-level property scoping).
- [ ] `CHANNEL_HTTP_ENABLED=false` (no live OTA egress).
- [ ] No secrets rendered by the UI (credential vault is write-only; status is metadata-only).
- [ ] HTTPS/TLS terminated in front of the backend; secure cookie/JWT handling.

## 5. Monitoring / logging / backup
- [ ] Liveness `GET /api/health/live` and readiness `GET /api/health/ready` wired to the platform health checks.
- [ ] Structured logs (pino) shipped; `LOG_LEVEL` set appropriately; **no secret logging** (verified in code).
- [ ] DB observability (`DB_OBSERVABILITY=true`) metrics/slow-query captured (SQL hash only).
- [ ] Automated DB backups + tested restore; retention defined.
- [ ] Alerting on readiness failures, error rate, and DB health.

## 6. Build / test gates
- [ ] `npm ci` reproducible install succeeds.
- [ ] `npm run test:unit` green.
- [ ] `npm run test:db:guarded` green against the target-parity Postgres.
- [ ] Frontend logic tests green (CI `frontend` job).
- [ ] `SMOKE_TEST_CHECKLIST.md` executed post-deploy.
