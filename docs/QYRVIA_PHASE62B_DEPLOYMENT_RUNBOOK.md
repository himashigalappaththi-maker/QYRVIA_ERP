# QYRVIA Phase 62B — Auth Resolver Deployment Runbook

## 1. Overview

Phase 62A introduced four `SECURITY DEFINER` functions in the `auth_resolvers`
schema. These functions allow the login service to resolve user/tenant identity
before an RLS tenant context (`app.tenant_id` GUC) has been established — the
pre-auth phase. This document describes the exact deployment procedure, role
separation, and rollback/recovery for the auth resolver infrastructure.

---

## 2. Role Separation

| Role | Attributes | Owns | Granted |
|---|---|---|---|
| `qyrvia_auth_schema_owner` | NOLOGIN NOBYPASSRLS NOSUPERUSER | `auth_resolvers` schema | — |
| `qyrvia_auth_resolver` | NOLOGIN BYPASSRLS NOSUPERUSER | 4 resolver functions | column-level SELECT on public tables |
| `<APP_ROLE>` (e.g. `qyrvia_test`) | LOGIN NOBYPASSRLS NOSUPERUSER | public schema tables | EXECUTE on 4 functions; USAGE on schema |

**Why two roles instead of one?**
- `qyrvia_auth_resolver` must have `BYPASSRLS` so its `SECURITY DEFINER` functions
  can SELECT across tenant boundaries during the pre-auth phase.
- Owning the schema with a `BYPASSRLS` role would be a security misconfiguration
  — any future object created in that schema would also be owned by the BYPASSRLS
  role. The schema is therefore owned by `qyrvia_auth_schema_owner` (NOBYPASSRLS).

---

## 3. Deployment Procedure

### Step 0 — Prerequisites

All steps in the standard QYRVIA DB provisioning must be complete:
- PostgreSQL instance running.
- `<APP_ROLE>` login role created (via `scripts/ci-provision-db.js`).
- Database owned by `<APP_ROLE>`.
- Extensions `pgcrypto` and `uuid-ossp` pre-installed by CI provisioner.

### Step 1 — Run Privileged Bootstrap (superuser required)

This step creates the roles, schema, and SECURITY DEFINER functions. It does NOT
run via the migration runner; it must be invoked manually by a DBA or deployment
automation with superuser (or CREATEROLE + BYPASSRLS) access.

```bash
psql "$SUPERUSER_DATABASE_URL" \
    --set APP_ROLE=<application_login_role> \
    --single-transaction \
    -f server/scripts/db/phase62a_auth_resolvers_bootstrap.sql
```

**Local dev example:**
```bash
psql "postgresql://postgres:pw@127.0.0.1:5432/qyrvia_test" \
    --set APP_ROLE=qyrvia_test \
    --single-transaction \
    -f server/scripts/db/phase62a_auth_resolvers_bootstrap.sql
```

The script:
- Fails with a clear error if `APP_ROLE` is not supplied.
- Uses psql quoted-identifier syntax (`:"APP_ROLE"`) — safe against identifier injection.
- Is idempotent: safe to re-run; existing roles/schema with correct attributes
  are preserved; unexpected attributes abort the transaction.
- Contains assertions in a DO block: the entire transaction rolls back atomically
  if any invariant (owner, SECURITY DEFINER, STABLE, no PUBLIC EXECUTE) fails.

### Step 2 — Run Migrations (application role)

After the bootstrap, run migrations as the application role:

```bash
cd server
DATABASE_URL="postgresql://<APP_ROLE>:<password>@<host>/<db>" \
  node src/db/migrate.js up
```

Migration `0083_auth_resolvers_grants.sql`:
- Checks that `qyrvia_auth_resolver` exists; fails with an actionable error if not
  (catching cases where Step 1 was skipped).
- Grants column-level SELECT on `public.users`, `public.tenants`,
  `public.properties`, `public.refresh_tokens` to `qyrvia_auth_resolver`.
- These grants are within the app role's authority (it owns the public tables).

### Step 3 — RLS Preflight

Verify the full RLS posture before starting the application:

```bash
cd server
DATABASE_URL="..." node scripts/rls-preflight.js
```

This checks: non-superuser role, FORCE RLS on all tenant tables, no PUBLIC table
grants, no UPDATE/DELETE on append-only tables, cross-tenant SELECT returns 0 rows.

### Step 4 — Start Application

```bash
cd server
DATABASE_URL="..." JWT_SECRET="..." node src/index.js
```

---

## 4. Local Dev vs Production

| Concern | Local dev | Production |
|---|---|---|
| `APP_ROLE` | `qyrvia_test` | Deployment-specific; never hard-coded in scripts |
| `SUPERUSER_DATABASE_URL` | Local postgres superuser | Ops-managed secret (CI/CD vault) |
| Bootstrap execution | Manual (once per `createdb`) | Automated pre-migration step in deployment pipeline |
| Migration execution | `npm run migrate` | Deployment pipeline after bootstrap |
| Credential source | `.env` file (never committed) | Secrets manager / env injection |

---

## 5. Column Grants — What and Why

`qyrvia_auth_resolver` is granted only the exact columns each resolver function
needs. No `password_hash` is granted; the functions never return it.

| Table | Columns granted | Used by |
|---|---|---|
| `public.users` | `id, tenant_id, email, username, soft_deleted_at` | `resolve_by_email`, `resolve_by_tenant_username`, `resolve_by_property_id_username` |
| `public.tenants` | `id, code` | `resolve_by_tenant_username` |
| `public.properties` | `id, tenant_id, active` | `resolve_by_property_id_username` |
| `public.refresh_tokens` | `id, tenant_id, user_id, token_hash` | `resolve_refresh_token_by_hash` |

---

## 6. RLS Preflight Checklist

Before certifying a deployment as production-ready, verify:

- [ ] `qyrvia_auth_resolver` role exists with BYPASSRLS; is NOLOGIN NOSUPERUSER
- [ ] `qyrvia_auth_schema_owner` role exists with NOBYPASSRLS; is NOLOGIN NOSUPERUSER
- [ ] `auth_resolvers` schema owned by `qyrvia_auth_schema_owner`
- [ ] Four functions in `auth_resolvers`, all SECURITY DEFINER, STABLE
- [ ] PUBLIC has no EXECUTE on any resolver function
- [ ] APP_ROLE has EXECUTE on all four functions and USAGE on schema
- [ ] APP_ROLE is NOSUPERUSER, NOBYPASSRLS (verified by `rls-preflight.js`)
- [ ] All tenant tables have ENABLE + FORCE ROW LEVEL SECURITY (verified by `rls-preflight.js`)
- [ ] Migration 0083 is recorded in `schema_migrations`
- [ ] Cross-tenant SELECT returns 0 rows (live smoke test in `rls-preflight.js`)

**Production readiness**: this document does not certify production readiness.
Run `node scripts/prod-preflight.js` and resolve all FAIL items before deploying.

---

## 7. Rollback / Recovery

### Remove auth resolver infrastructure

```sql
-- Connect as superuser
DROP SCHEMA auth_resolvers CASCADE;   -- drops all 4 functions
DROP ROLE qyrvia_auth_resolver;
DROP ROLE qyrvia_auth_schema_owner;
```

Then remove migration 0083 from `schema_migrations` (requires direct DB access)
and re-run from Step 1.

### Function replacement (no role/schema change)

```bash
# Re-run bootstrap with same APP_ROLE — CREATE OR REPLACE updates functions
psql "$SUPERUSER_DATABASE_URL" \
    --set APP_ROLE=<application_login_role> \
    --single-transaction \
    -f server/scripts/db/phase62a_auth_resolvers_bootstrap.sql
```

### Column grant recovery

```bash
# Re-run migration (remove from schema_migrations first, then run migrate.js up)
psql "$DATABASE_URL" -c "DELETE FROM schema_migrations WHERE version = '0083_auth_resolvers_grants'"
DATABASE_URL="..." node src/db/migrate.js up
```

---

## 8. Migration / Bootstrap Responsibility Boundary

```
Deployment pipeline:
  [1] ci-provision-db.js         (superuser)  →  creates APP_ROLE
  [2] phase62a_auth_resolvers_bootstrap.sql   →  creates resolver roles, schema, functions
                                  (superuser)
  [3] src/db/migrate.js up       (APP_ROLE)   →  schema, RLS, tables, column grants (0083)
  [4] rls-preflight.js           (APP_ROLE)   →  verifies RLS posture
  [5] prod-preflight.js          (APP_ROLE)   →  environment + file + DB smoke checks
  [6] node src/index.js          (APP_ROLE)   →  application start
```

Step 2 (bootstrap) must precede Step 3 (migrations). Migration 0083 will abort
with an actionable error if the bootstrap was skipped.
