# QYRVIA ERP — Production Deployment Runbook

Phase 61 deployment guide. Read from top to bottom before first deploy.

---

## Pre-deployment checklist

Run the preflight gate before every production deployment:

```bash
NODE_ENV=production node scripts/prod-preflight.js
```

All items must show `PASS` or `WARN`. Any `FAIL` is a hard blocker.

---

## Required environment variables

| Variable | Requirement | Example |
|---|---|---|
| `DATABASE_URL` | Required | `postgresql://qyrvia:…@db.host:5432/qyrvia` |
| `JWT_SECRET` | Required, ≥ 64 chars, non-placeholder | `$(openssl rand -base64 64)` |
| `APP_BASE_URL` | Must not be localhost | `https://app.qyrvia.com` |
| `PAYMENT_PROVIDER` | Must not be `mock` | `stripe` |
| `NODE_ENV` | Must be `production` | `production` |

Generate a JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

---

## Optional but recommended for production

| Variable | Default | Notes |
|---|---|---|
| `CORS_ORIGIN` | `''` (same-origin only) | Set to SPA origin: `https://app.qyrvia.com` |
| `TRUST_PROXY` | `1` | Set to `1` behind one nginx/ALB hop. Do not use `true`. |
| `QYRVIA_NOTIFICATION_ENCRYPTION_KEY` | `''` | Required when `SMTP_HOST` or `RESEND_API_KEY` is set |
| `CHANNEL_CREDENTIAL_KEY` | `''` | Required when OTA activations are configured |

---

## Database setup

```bash
# Run all pending migrations (idempotent, tracked in schema_migrations)
node src/db/migrate.js

# Verify RLS preflight (superuser check + FORCE RLS on tenant tables)
node scripts/rls-preflight.js

# Full production preflight
NODE_ENV=production node scripts/prod-preflight.js
```

The migration runner applies files from `src/db/migrations/` in lexical order.
Each file is applied exactly once; already-applied versions are skipped.

---

## Starting the server

```bash
NODE_ENV=production node src/index.js
```

The process exits with code `2` if any required environment variable is missing
or any production validation gate fails.

---

## Graceful shutdown

The server handles `SIGTERM` and `SIGINT`:

1. Stop accepting new HTTP connections (`server.close`)
2. Drain the PostgreSQL pool (`db.close`)
3. Exit with code `0` if clean, `1` if any cleanup step failed

A forced exit fires after `10 seconds` (bounded worst-case).

Send `SIGTERM` to trigger graceful shutdown:
```bash
kill -TERM <pid>
```

---

## Health endpoints

| Endpoint | Purpose | Expected in production |
|---|---|---|
| `GET /health/live` | Liveness (always 200 if process is up) | Used by k8s liveness probe |
| `GET /health/ready` | Readiness (pings DB) | Used by k8s readiness probe; 503 if DB unreachable |

---

## Reverse proxy (nginx)

Set `TRUST_PROXY=1` when exactly one nginx/ALB hop sits in front. Example nginx block:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3001/api/;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
}
```

---

## CORS

Set `CORS_ORIGIN` to the exact SPA origin (no trailing slash):

```
CORS_ORIGIN=https://app.qyrvia.com
```

Only this origin receives `Access-Control-Allow-Origin`. Wildcard (`*`) is never emitted.

---

## Rolling back

Migrations are additive and non-destructive. To roll back application code:

1. Deploy the previous image/release
2. Do **not** run `migrate.js` — the database is forward-compatible with the previous code
3. If a migration must be reversed, write a new `NNNN_rollback_*.sql` migration

---

## Secrets rotation

**JWT_SECRET rotation (zero downtime):**

1. Set `JWT_SECRET_PREV` to the current `JWT_SECRET`
2. Set `JWT_SECRET` to the new secret
3. Deploy — new tokens are signed with the new key; existing tokens verify against either
4. After `ACCESS_TOKEN_TTL_SEC` has elapsed (default 900 s), unset `JWT_SECRET_PREV`

---

## Post-deploy verification

```bash
# Liveness
curl -sf https://app.qyrvia.com/health/live

# Readiness (DB reachable)
curl -sf https://app.qyrvia.com/health/ready

# Quick auth smoke-test (expect 401, not 500)
curl -sf https://app.qyrvia.com/api/auth/me
```
