# DB-mode integration tests (Phase 9.1)

These tests run the real SQL against a real PostgreSQL, proving what the
in-memory unit fixtures cannot: migration correctness, FK/CHECK/ENUM/NOT
NULL/UNIQUE enforcement, Row-Level Security, and balanced financial flows.

## Two test modes

| Mode | Command | Backend |
|------|---------|---------|
| Unit (existing, unchanged) | `npm run test:unit` | in-memory fakes (`test/_fixtures.js`) |
| DB (new) | `npm run test:db` | real PostgreSQL via `TEST_DATABASE_URL` |

`npm test` runs everything; the `*.db.test.js` files **skip automatically**
when `TEST_DATABASE_URL` is unset, so unit-only machines stay green.

## Run locally

```bash
cd server
npm run db:test:up            # starts postgres:16-alpine on :55432
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/qyrvia_test \
  JWT_SECRET=local-dev-jwt-secret-at-least-32-characters \
  npm run test:db
npm run db:test:down          # stop + remove volume
```

## CI

`.github/workflows/ci.yml` runs both jobs on every push/PR: `unit` (no DB) and
`db` (a `postgres:16-alpine` service container). The `db` job first runs the
production migration runner (`node src/db/migrate.js up`) to confirm the chain
applies cleanly, then `npm run test:db`.

## What each file covers

- `_dbHarness.js` — fresh-schema + migration applier, restricted RLS role,
  `withTenant`, real audit/event DB facade.
- `schema_and_constraints.db.test.js` — migration chain + FK/CHECK/ENUM/NOT
  NULL/UNIQUE negative tests.
- `rls.db.test.js` — tenant read/write isolation under a non-superuser role,
  append-only enforcement, and the superuser-bypass gap.
- `finance_flows.db.test.js` — invoice→ledger bridge, payment-allocation
  balance rule, imbalance rejection, idempotency, cost-center tagging, audit
  logging — all verified by reading rows back from the database.
