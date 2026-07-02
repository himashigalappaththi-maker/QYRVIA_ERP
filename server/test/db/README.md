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

## Single-role model (RLS-aware)

The DB tests connect as a **NON-superuser** role (`qyrvia_test`). A superuser
bypasses Row-Level Security — `FORCE` included — so isolation cannot be proven on
one. RLS is validated by data-visibility outcomes while switching `app.tenant_id`
on that single role. **No superuser, no `SET ROLE`, no `CREATE ROLE` at test
runtime.** A superuser is used only once, out-of-band, to create the role.

## Run locally

Provision the role once (as the postgres superuser), then run guarded:

```bash
cd server
# one-time: create the non-superuser role + give it schema ownership
SUPERUSER_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:5432/qyrvia_test \
  APP_ROLE=qyrvia_test APP_ROLE_PASSWORD=<role-pw> npm run db:provision

export TEST_DATABASE_URL=postgresql://qyrvia_test:<role-pw>@127.0.0.1:5432/qyrvia_test
export DATABASE_URL=$TEST_DATABASE_URL
export JWT_SECRET=local-dev-jwt-secret-at-least-32-characters
node src/db/migrate.js up      # provision schema as qyrvia_test (out-of-band)
npm run test:db:guarded        # RLS preflight gate, then the DB suite
```

`npm run db:preflight` alone runs the gate: it exits non-zero on a
superuser/BYPASSRLS connection, missing FORCE RLS, a `PUBLIC` UPDATE/DELETE leak
on append-only tables, or a live cross-tenant leak.

## CI

`.github/workflows/ci.yml` runs `unit` (no DB) and `db` (RLS-aware) on every
push/PR. The `db` job: provisions the non-superuser `qyrvia_test` role
(`db:provision`, the only superuser use), migrates as that role, runs the **RLS
preflight gate** (`db:preflight`) which STOPS the job on a superuser/leak, then
`npm run test:db`. The in-suite `rls_guard.db.test.js` enforces the same
invariants so no regression can reintroduce superuser-based testing.

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
