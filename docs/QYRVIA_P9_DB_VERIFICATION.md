# QYRVIA — Phase 9.1: Real PostgreSQL Verification Report

> **Objective (per brief):** introduce a real PostgreSQL integration test layer
> and execute it in CI, so every financial, relational, and constraint
> guarantee is validated against an actual database — not in-memory fakes.
>
> **Infrastructure truth enforcement only.** No product features, UI, business
> logic, or AI work was added. The only code added is the test harness + DB
> tests + CI wiring.

---

## 0. Execution Status — ✅ CI-VERIFIED (real results below)

The database truth layer has been **executed in CI against a real
`postgres:16-alpine` service container.** The system has moved from
"designed database correctness" → "CI-verified database truth."

| Item | Result |
|---|---|
| Repository | `https://github.com/himashigalappaththi-maker/QYRVIA_ERP` |
| Green CI run | **#27957714724** — commit `e614631`, branch `main`, **conclusion: success** |
| Job `Unit (in-memory)` | ✅ success (19s) — `npm run test:unit` |
| Job `Integration (real PostgreSQL)` | ✅ success (33s) |
| → Step "Verify migration chain applies cleanly (0001..NNNN)" | ✅ success — `node src/db/migrate.js up` against the service container |
| → Step "DB-backed integration tests (RLS, constraints, finance flows)" | ✅ success — `npm run test:db` |
| In-memory DB used in the DB suite? | **No** — DB suite runs real `pg` + `buildRepos(pool)` against the container |

`node --test` exits non-zero on any failing or unresolved test; both test
steps exited **0**, so all assertions below passed.

### Truth-execution trace (the path to green)

| Run | Commit | Result | Why |
|---|---|---|---|
| #27956762317 | `c9748b0` baseline | ❌ failure | CI pinned Node 20; `node --test "<glob>"` only expands globs on Node ≥ 21 → both test steps matched nothing/errored. |
| #27957472122 | `ae9724d` Node 22 | ❌ failure | Unit job passed; DB job failed — `node --test` runs the 3 DB files **in parallel**, and they all reset the **same** database in `freshSchema()` → race. |
| **#27957714724** | **`e614631` serial DB** | ✅ **success** | DB files forced serial (`--test-concurrency=1`); Node 22 glob expansion. Both jobs green. |

> Two genuine **CI-only defects** were found by the act of running in CI (not
> reproducible on the Windows authoring machine, which runs Node 24): the
> Node-version glob dependency and the shared-DB parallelism race. Both are
> fixed and committed.

---

## 1. Migrations Applied (executed in CI)

CI ran the production migration runner (`node src/db/migrate.js up`) against the
real container, then each DB test file re-applied the full chain via
`_dbHarness.freshSchema()` (drop+recreate `public`, apply 0001..0044 in strict
lexical order inside per-file transactions, recording each in
`schema_migrations`; throws on the first failure). **Both succeeded — the full
44-migration chain applies cleanly to a real PostgreSQL 16, in order, with no
drift.**

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

`schema_and_constraints.db.test.js` additionally asserts (✅ passed):
`count(schema_migrations) == 44`, first = `0001_init`, last =
`0044_finance_ledger`, and that the core finance tables + `cost_center_type`
enum exist.

---

## 2. Constraint Coverage Matrix — ✅ ALL ENFORCED BY THE DATABASE

All in `schema_and_constraints.db.test.js`; all **PASS** in CI run #27957714724.

| # | Constraint kind | Guarantee | Enforced by (migration) | SQLSTATE on violation | Result |
|---|---|---|---|---|---|
| 1 | NOT NULL | `tenants.name` required | `0001_init` | `23502` | ✅ PASS |
| 2 | UNIQUE | `tenants.code` unique | `0001_init` | `23505` | ✅ PASS |
| 3 | UNIQUE (composite) | `cost_centers(tenant_id,property_id,code)` | `0042` | `23505` | ✅ PASS |
| 4 | ENUM | `cost_center_type` rejects unknown value | `0042` | `22P02` | ✅ PASS |
| 5 | FK | `ledger_entries.batch_id` — no orphan entries | `0044` | `23503` | ✅ PASS |
| 6 | FK | `cost_centers.property_id → properties` | `0042` | `23503` | ✅ PASS |
| 7 | CHECK | `ledger_batches` balanced (`total_debit = total_credit`) | `0044` | `23514` | ✅ PASS |
| 8 | CHECK | `ledger_entries` one-sided (`debit=0 OR credit=0`) | `0044` | `23514` | ✅ PASS |
| 9 | CHECK | `ledger_entries` non-negative amounts | `0044` | `23514` | ✅ PASS |

Brief step-7 negative tests covered and passing: invalid payment split
(`finance_flows.db.test.js` → over-allocation rejected, `allocation_exceeds_charge`);
orphan ledger entry (row 5); cross-tenant insert (§3); imbalance / missing-map
rejection (§4).

---

## 3. RLS & Append-Only — ✅ VALIDATED AGAINST REAL DB

`rls.db.test.js` runs as a **dedicated non-superuser, `NOBYPASSRLS` role**
(`qyrvia_app_rls`, granted only `SELECT, INSERT`) so RLS policies actually bind.
It establishes context exactly like production (`SELECT set_config(
'app.tenant_id', $1, true)`). All **PASS** in CI run #27957714724.

| Test | Asserts | Result |
|---|---|---|
| Superuser/owner bypass | owner pool (no context) sees **all** tenants — documents the production gap | ✅ PASS |
| Tenant A context | bound role sees only tenant A rows | ✅ PASS |
| Tenant B context | bound role sees only tenant B rows | ✅ PASS |
| No context | bound role sees **zero** rows (NULL predicate) | ✅ PASS |
| Cross-tenant read | tenant A cannot fetch a tenant B row by id | ✅ PASS |
| Cross-tenant **write** | inserting a tenant B row under tenant A context rejected (`42501`) | ✅ PASS |
| Append-only | bound role cannot `UPDATE`/`DELETE` `audit_events` (`42501`) | ✅ PASS |
| Append-only (PUBLIC) | `UPDATE`/`DELETE` revoked from PUBLIC on `audit_events`, `event_store`, `ledger_entries` | ✅ PASS |

### Two findings confirmed by execution

1. **Production connects as the DB owner, which BYPASSES RLS.** `src/db/repos.js`
   queries through a single owner-credential pool and never sets
   `app.tenant_id`; superusers/owners bypass RLS even under `FORCE`. The CI
   "superuser bypass" test proves it (owner sees all 3 rows). **Today tenant
   isolation in production rests on the explicit `WHERE tenant_id = $1` in each
   repo, not on RLS.** RLS is a verified latent defense that activates only when
   the app connects as a bound role and sets context.
   → *Runtime remediation (out of Phase 9.1 scope):* run the app under a
   non-superuser role and route repo queries through `withTenant`.
2. **`USING`-only policies also gate writes.** PostgreSQL applies the `USING`
   expression as `WITH CHECK` when no explicit `WITH CHECK` is given, so under a
   bound role a cross-tenant `INSERT` is rejected (`42501`) — now proven, and it
   *corrects* the more pessimistic note in the Phase-9 audit (§3/§6).

---

## 4. Finance Flows — ✅ REAL PERSISTENCE, BALANCE ENFORCED

`finance_flows.db.test.js` exercises production code paths — real
`buildRepos(pool)`, real `ledgerService`, real eventBus → real `audit_events` /
`event_store` — and verifies by reading rows back. All **PASS** in CI run
#27957714724.

| Test | Asserts (read back from DB) | Result |
|---|---|---|
| Invoice → ledger | settled folio → invoice issues a balanced AR/Revenue batch; 2 entries sum debit==credit==100; `cost_center_id` tagged on each leg; batch row balanced; `invoice.issued` + `ledger.batch_posted` + `revenue.mapped` in `audit_events`; `ledger.batch_posted` in `event_store` | ✅ PASS |
| Imbalance rejection | unbalanced `finance.ledger.post` → `ledger_imbalance`; **0** rows persisted; `ledger.imbalance_rejected` audited | ✅ PASS |
| Idempotency | same reference posted twice → 2nd idempotent; exactly **2** entries in DB | ✅ PASS |
| Payment allocation | allocation posts a balanced Cash/AR batch (60/60); credit leg = `AR` | ✅ PASS |
| Balance rule | explicit over-allocation rejected (`allocation_exceeds_charge`) | ✅ PASS |
| Cost-center report | `reportByCostCenter` aggregates real ledger rows by cost center | ✅ PASS |

This satisfies the brief's "≥80% of financial flows DB-backed (not mocked)":
invoice→ledger, payment allocation (+ balance rule), manual ledger
post/imbalance/idempotency, and cost-center reporting all run against real
PostgreSQL.

---

## 5. Fake-vs-Real DB Divergence List

Behaviours the in-memory fakes (`test/_fixtures.js`) cannot represent, now
proven enforced by the real database:

| Area | In-memory fake | Real PostgreSQL (CI-verified) |
|---|---|---|
| RLS / tenant isolation | not modelled (JS `.filter`) | enforced by policy under a bound role (✅ §3) |
| CHECK (balanced batch, one-sided, non-negative) | not enforced | enforced — bad rows rejected `23514` (✅ §2) |
| FK (orphan ledger entry, bad property ref) | not enforced | enforced `23503` (✅ §2) |
| ENUM (`cost_center_type`, …) | accepts any string | enforced `22P02` (✅ §2) |
| UNIQUE (composite keys) | partial / hand-rolled | enforced `23505` (✅ §2) |
| `folios.balance` rollup | recomputed in JS | recomputed in SQL `UPDATE … SUM(amount)` (✅ §4) |
| Append-only (`REVOKE UPDATE,DELETE`) | not modelled | privilege denial `42501` (✅ §3) |
| Audit/event dual-persist | push to JS array | real `INSERT` into `audit_events` + `event_store` (✅ §4) |
| Migration SQL correctness | text-only check (`migrationValidation.test.js`) | **executed** end-to-end, in order (✅ §1) |

**Net:** the fakes validate *application logic*; only the DB layer validates the
*database contract*. Phase 9.1 closes that gap for the financial + relational
core and runs it on every push.

---

## 6. Remaining Risks (unchanged by 9.1; from the Phase-9 audit)

1. **Production RLS bypass (§3 finding 1)** is a *runtime wiring* issue (owner
   connection, no `withTenant` in repos), not a test gap. 9.1 documents and
   proves it but does not change runtime wiring (out of scope).
2. **Coverage focuses on the finance + relational core** per the brief. PMS
   operational command flows remain primarily unit-tested; extending DB mode to
   them is a follow-up.
3. **Revenue snapshots** appear in the brief's wish-list but **do not exist** in
   the codebase (confirmed Phase-9 audit §4); no test was written for a
   non-existent feature.
4. **Growth / retention / DR / partitioning** (Phase-9 audit §7/§13) are
   untouched by 9.1.
5. **DB suite must run serially** (`--test-concurrency=1`) because all files
   share one database and reset the schema. Parallelising would require a
   database-per-file harness change.

---

## 7. Acceptance Criteria — ✅ MET

| Brief criterion | Status |
|---|---|
| CI pipeline runs successfully with PostgreSQL | ✅ run #27957714724 success |
| All migrations execute in CI (0001→0044, in order) | ✅ migrate step + freshSchema both green |
| DB test suite runs against real database | ✅ `npm run test:db` (real `pg`, no fakes) |
| RLS isolation tested against real DB | ✅ §3, bound non-superuser role |
| Constraints enforced (FK/CHECK/ENUM/NOT NULL/UNIQUE) | ✅ §2 |
| Finance flows on real persistence | ✅ §4 |
| No in-memory DB in the DB suite | ✅ verified |
| ≥1 full integration run recorded | ✅ this report + run URL |
| Verification report updated with real evidence | ✅ this file |

**Definition of Done met:** the system has transitioned from
*designed database correctness* → *CI-verified database truth*.
CI run: https://github.com/himashigalappaththi-maker/QYRVIA_ERP/actions/runs/27957714724

---

*No product features, UI, business logic, or AI were added in Phase 9.1.*
