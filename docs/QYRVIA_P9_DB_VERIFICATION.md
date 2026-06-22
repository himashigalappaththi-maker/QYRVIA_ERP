# QYRVIA — Phase 9.1: Real PostgreSQL Verification Report

> **Objective (per brief):** introduce a real PostgreSQL integration test layer
> so every financial, relational, and constraint guarantee is validated against
> an actual database — not in-memory fakes.
>
> **This phase is infrastructure truth enforcement only.** No product features,
> UI, business logic, or AI work was added. The only code added is test
> harness + DB tests + CI wiring.

---

## 0. Execution Status (read first — no fabricated results)

| Deliverable | Status |
|---|---|
| DB test harness (`test/db/_dbHarness.js`) | ✅ Authored |
| Migration-chain + constraint tests (`schema_and_constraints.db.test.js`) | ✅ Authored |
| RLS tests (`rls.db.test.js`) | ✅ Authored |
| Finance-flow DB tests (`finance_flows.db.test.js`) | ✅ Authored |
| CI workflow with PostgreSQL service (`.github/workflows/ci.yml`) | ✅ Authored |
| npm scripts (`test:db`, `db:test:up/down`) + compose + README | ✅ Authored |
| Unit mode unchanged + DB files skip cleanly without a DB | ✅ **Verified** — `npm test` → 350 pass, 3 skipped, 0 fail |
| **Live local execution against a real container** | ⏳ **Not executed in this authoring environment** |

**Why not executed here:** the authoring machine is Windows with Docker Desktop
whose Linux engine did not finish initializing during this session (the
`Docker Desktop` and `com.docker.backend` processes started, but
`docker info` never returned — a cold first-launch / WSL engine gate). No local
`psql`/`postgres` binary is available as an alternative. The suite is therefore
**fully built, CI-wired, and proven to load/skip correctly**, but the
green/red results of the DB assertions must be produced by **CI** (which has a
guaranteed Postgres service) or by a local run once the engine is up.

This report does **not** claim any DB test "passed." Every constraint/RLS row
below states *what the test asserts* and *where the database enforces it*
(migration file), and is marked **`PENDING-RUN`** until first execution. After
the first CI run, replace the PENDING markers with the run summary.

**How to execute (produces the real evidence):**

```bash
cd server
npm run db:test:up        # postgres:16-alpine on :55432
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/qyrvia_test \
  JWT_SECRET=local-dev-jwt-secret-at-least-32-characters \
  npm run test:db
npm run db:test:down
```

Or push to a branch — `.github/workflows/ci.yml` runs the `db` job
automatically against a `postgres:16-alpine` service container, including
`node src/db/migrate.js up` to confirm the chain applies cleanly.

---

## 1. Migrations Applied (chain executed by the harness / CI)

`test/db/_dbHarness.js::freshSchema()` drops and recreates the `public` schema,
then applies these **44** files in strict lexical order inside per-file
transactions, recording each in `schema_migrations`. It throws on the **first**
failure (missing file, ordering gap, or SQL error), satisfying brief step 2.

```
0001_init                         0023_arch_folio_housekeeping
0002_identity                     0024_arch_travel_commerce
0003_seed_roles                   0025_arch_night_audit
0004_rls_policies                 0026_arch_channel_revenue_reputation
0005_business_date                0027_arch_guest_experience_mobile_access
0006_event_store                  0028_arch_ai_restaurant
0007_scheduler                    0029_arch_enterprise_reservations
0008_notifications                0030_arch_reserved_permissions
0009_settings                     0031_settings_catalog
0010_files                        0032_auth_property_login
0011_connectors                   0033_pms_meal_plans
0012_webhooks                     0034_night_audit_schedule
0013_phase3_permissions           0035_audit_indexes
0014_aggregate_snapshots          0036_ai_messages_revoke
0015_scheduler_recurrence         0037_pms_payment_allocations
0016_pms_property_structure       0038_pms_invoices
0017_pms_guests                   0039_pms_allocation_lifecycle
0018_pms_child_policies           0040_pms_vouchers
0019_pms_reservations             0041_pms_group_lifecycle
0020_pms_rate_plans               0042_finance_cost_centers
0021_pms_permissions              0043_finance_revenue_posting_map
0022_arch_hardening_multiproperty 0044_finance_ledger
```

`schema_and_constraints.db.test.js` asserts: `count(schema_migrations) == 44`,
first = `0001_init`, last = `0044_finance_ledger`, and that the core finance
tables + `cost_center_type` enum exist. **Status: PENDING-RUN.**

---

## 2. Constraint Coverage Matrix

Each row: the guarantee, the database object that enforces it (migration), and
the test that asserts the DB rejects a violation. All in
`schema_and_constraints.db.test.js` unless noted. Status **PENDING-RUN** until
first execution.

| # | Constraint kind | Guarantee | Enforced by (migration) | Test assertion | SQLSTATE | Status |
|---|---|---|---|---|---|---|
| 1 | NOT NULL | `tenants.name` required | `0001_init` | insert tenant w/o name rejected | `23502` | PENDING-RUN |
| 2 | UNIQUE | `tenants.code` unique | `0001_init` | duplicate code rejected | `23505` | PENDING-RUN |
| 3 | UNIQUE (composite) | `cost_centers(tenant_id,property_id,code)` | `0042` | duplicate CC code rejected | `23505` | PENDING-RUN |
| 4 | ENUM | `cost_center_type` ∈ {ROOM,FNB,SPA,ADMIN,OTHER} | `0042` | type `'BANANA'` rejected | `22P02` | PENDING-RUN |
| 5 | FK | `ledger_entries.batch_id → ledger_batches` (no orphans) | `0044` | orphan entry rejected | `23503` | PENDING-RUN |
| 6 | FK | `cost_centers.property_id → properties` | `0042` | nonexistent property rejected | `23503` | PENDING-RUN |
| 7 | CHECK | `ledger_batches` balanced (`total_debit = total_credit`) | `0044` | `(10,5)` rejected | `23514` | PENDING-RUN |
| 8 | CHECK | `ledger_entries` one-sided (`debit=0 OR credit=0`) | `0044` | `(5,5)` rejected | `23514` | PENDING-RUN |
| 9 | CHECK | `ledger_entries` non-negative amounts | `0044` | `(-5,0)` rejected | `23514` | PENDING-RUN |

Brief step-7 negative tests covered: invalid payment split
(`finance_flows.db.test.js` → "explicit over-allocation rejected",
`allocation_exceeds_charge`); orphan ledger entry (row 5); cross-property /
cross-tenant insert (§3 below); missing cost-center where required
(`finance_flows.db.test.js` imbalance/mapping rejection + app-level
`cost_center_required` from Phase 8).

---

## 3. RLS Test Results & Findings

`rls.db.test.js` connects a **dedicated non-superuser, NOBYPASSRLS role**
(`qyrvia_app_rls`, granted only `SELECT, INSERT`) so RLS policies actually bind.
It uses the same context mechanism as production (`SELECT set_config(
'app.tenant_id', $1, true)` inside a transaction — identical to
`db/client.js withTenant()`).

| Test | Asserts | Status |
|---|---|---|
| Superuser/owner bypass | owner pool with no context sees **all** tenants (documents the production gap) | PENDING-RUN |
| Tenant A context | restricted role sees only tenant A rows | PENDING-RUN |
| Tenant B context | restricted role sees only tenant B rows | PENDING-RUN |
| No context | restricted role sees **zero** rows (NULL predicate) | PENDING-RUN |
| Cross-tenant read | tenant A cannot fetch a tenant B row by id | PENDING-RUN |
| Cross-tenant **write** | inserting a tenant B row under tenant A context is rejected (`42501`) | PENDING-RUN |
| Append-only | restricted role cannot `UPDATE`/`DELETE` `audit_events` (`42501`) | PENDING-RUN |
| Append-only (PUBLIC) | `has_table_privilege('public', t, 'UPDATE'/'DELETE') = false` for `audit_events`, `event_store`, `ledger_entries` | PENDING-RUN |

### Two findings that this layer makes explicit (from migration `0004` + schema reading)

1. **Production connects as the DB owner, which BYPASSES RLS.** `src/db/repos.js`
   issues every query through a single `pool` (owner credentials) and does **not**
   call `withTenant()`/`set_config('app.tenant_id', …)`. Superusers and table
   owners bypass RLS even under `FORCE ROW LEVEL SECURITY`. **Today, tenant
   isolation in production rests entirely on the explicit `WHERE tenant_id = $1`
   in each repo method, not on RLS.** RLS is a latent defense that only activates
   if the app connects as a restricted role *and* sets the context.
   → *Remediation candidate (not done in 9.1):* run the app under a
   non-superuser role and route repo queries through `withTenant`.

2. **The `USING`-only policies (migration `0004`/`0042`/`0043`/`0044`) also
   restrict writes.** PostgreSQL applies a policy's `USING` expression as the
   `WITH CHECK` when no explicit `WITH CHECK` is given, so under a bound role a
   cross-tenant `INSERT` is rejected (`42501`). This *corrects* the more
   pessimistic note in the Phase-9 audit (§3/§6), which assumed write-side
   isolation was unenforced — it is enforced **for a bound role**, but moot for
   the owner connection used in production (finding 1).

---

## 4. Fake-vs-Real DB Divergence List

Behaviours the in-memory fakes (`test/_fixtures.js`) cannot represent, which the
real-DB layer now exercises:

| Area | In-memory fake | Real PostgreSQL |
|---|---|---|
| RLS / tenant isolation | not modelled (JS array `.filter`) | enforced by policy (bound role) — divergence: fakes can't catch a missing `WHERE tenant_id` |
| `CHECK` (balanced batch, one-sided, non-negative) | not enforced — fake `insertLedgerEntry` stores any numbers | enforced; bad rows rejected (`23514`) |
| FK (orphan ledger entry, bad property ref) | not enforced — fakes accept any id | enforced (`23503`) |
| ENUM (`cost_center_type`, `folio_charge_type`, `invoice_status`) | not enforced — fake stores any string | enforced (`22P02`) |
| UNIQUE (composite keys) | partial (some fakes hand-roll dup checks; many don't) | enforced (`23505`) |
| `folios.balance` rollup | recomputed in JS in `_makeFolioMemoryRepo` | recomputed in SQL `UPDATE … SUM(amount)` — divergence if SQL aggregation differs |
| Append-only (`REVOKE UPDATE,DELETE`) | not modelled | enforced at privilege level (`42501`) |
| Idempotency by reference | fake array scan | real `findLedgerByReference` SQL — same logic, now over a real index |
| Audit/event dual-persist | fake pushes to a JS array | real `INSERT` into `audit_events` + `event_store` (catches column/type drift) |
| Migration SQL correctness | only validated as **text** (`migrationValidation.test.js`) | executed — catches real SQL errors, ordering, type/enum creation |

**Net:** the fakes validate *application logic*; they cannot validate the
*database contract*. Phase 9.1 closes that gap for the financial and relational
core.

---

## 5. Remaining Risks

1. **First live run still pending here.** Until CI (or a local engine) runs the
   `db` job once, the PENDING-RUN rows are unconfirmed. CI is wired to do this on
   the next push. *(Environment limitation, not a code gap.)*
2. **Production RLS bypass (finding 1)** remains true regardless of this test
   layer — it is a *runtime wiring* issue (owner connection, no `withTenant` in
   repos). Phase 9.1 documents and tests the gap but does not change runtime
   wiring (out of scope: "no business logic expansion").
3. **Coverage is focused on the finance + relational core**, per the brief's
   priority list. PMS operational flows that only exist as commands (e.g. full
   reservation lifecycle) are still primarily unit-tested; extending DB mode to
   them is a follow-up.
4. **Revenue snapshots** appear in the brief's coverage list but **do not exist**
   in the codebase (no `revenue_snapshots` write path — confirmed in the Phase-9
   audit §4). No DB test was written for a non-existent feature.
5. **Connection-role hardening, partitioning, and data-retention** (flagged in
   the Phase-9 audit §7/§13) are unchanged; DB mode does not address growth or DR.

---

## 6. Acceptance Criteria Check

| Brief criterion | Status |
|---|---|
| CI runs PostgreSQL container successfully | ✅ Wired (`.github/workflows/ci.yml` `db` job, `postgres:16-alpine` service) — runs on next push |
| All 0001–0044 migrations execute cleanly | ✅ Mechanism in place (`migrate.js up` step + `freshSchema`); ⏳ first execution pending CI |
| ≥1 full integration suite runs against real DB | ✅ Three suites authored; ⏳ execution pending engine |
| RLS actively tested and enforced | ✅ Tests authored (bound non-superuser role); ⏳ run pending |
| ≥80% of financial flows DB-backed | ✅ Invoice→ledger, payment allocation (+balance rule), manual ledger post/imbalance/idempotency, cost-center report — all via real repos against real DB |
| Report generated with full evidence | ✅ This file |

**Honest bottom line:** the system has the **mechanism** to transition from
"tested logic" → "tested database reality," fully wired into CI. The transition
**completes on the first CI run** (or local run per §0). It is not yet proven on
this authoring machine because the Docker engine did not initialize here.

---

*No product features, UI, business logic, or AI were added in Phase 9.1.*
