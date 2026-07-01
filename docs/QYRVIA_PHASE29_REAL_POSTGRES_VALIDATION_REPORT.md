# QYRVIA ERP — Phase 29: Real PostgreSQL Validation Report

**Version:** V35
**Date:** 2026-06-25
**Status:** ✅ Completed — persistence-critical paths validated against real PostgreSQL 18.4. Awaiting approval before Phase 30.

---

## 1. Environment Used

| Item | Value |
|---|---|
| Host OS | Windows 10 Pro (10.0.19045) |
| Database | PostgreSQL **18.4**, local service `postgresql-x64-18`, `127.0.0.1:5432` |
| Test database | `qyrvia_test` (dedicated, isolated; **not** any production/app DB) |
| Login role | `qyrvia_test` — **non-superuser**, owner of `qyrvia_test` DB. NOSUPERUSER, no `BYPASSRLS` |
| Auth | `scram-sha-256` |
| Test runner | `node --test --test-concurrency=1` (Node 20+) |
| Activation | `TEST_DATABASE_URL=postgresql://qyrvia_test:***@127.0.0.1:5432/qyrvia_test` |

> Docker was attempted first but its Desktop/WSL2 engine would not initialize headlessly (three timed attempts); validation proceeded against the locally-installed PostgreSQL 18 instead.

### Real database setup (one-time, OUTSIDE test runtime)
1. `CREATE ROLE qyrvia_test LOGIN PASSWORD …; CREATE DATABASE qyrvia_test OWNER qyrvia_test;` (run as the `postgres` superuser).
2. Schema provisioned with the production migration runner: `node src/db/migrate.js up` → **48/48 migrations applied** (additive; no `DROP`).

The role is deliberately **non-superuser** so that `FORCE ROW LEVEL SECURITY` binds it — RLS is therefore exercised by the same principal the tests use, with no privilege escalation.

---

## 2. PostgreSQL Version

`server_version = 18.4` (matches the production target line; migrations pinned to `postgres:16+`-compatible SQL, validated here on 18.4).

---

## 3. Test Architecture & Boundary

**Strict data-level boundary (per directive):** the Phase-29 suites perform **no DDL, no `CREATE ROLE`, no `DROP SCHEMA`, no migration at runtime, and no privilege escalation**. They:
- assume the schema is already provisioned + migrated,
- connect with the single existing role `qyrvia_test`,
- seed fixtures with `INSERT`, assert with `SELECT/UPDATE/DELETE`,
- prove RLS by **data-visibility outcomes only** (switching `app.tenant_id`),
- are **run-scoped** (every assertion filters by this run's freshly-generated tenant ids, since the DB is never reset), and
- clean up their own fixtures with `DELETE` in `after()`.

Because the channel tables (and `tenants`/`properties`/`audit_events`) use `FORCE ROW LEVEL SECURITY`, RLS binds even the table-owner role, so isolation is validated on the single `qyrvia_test` role — **no restricted/second role is created**.

**Confirmation of zero schema mutation during runtime tests:** the three suites issue only DML (`INSERT/SELECT/UPDATE/DELETE`) inside tenant transactions; the only schema/DDL (`migrate up`) ran once as an explicit setup step **before** the test run, never inside a test. ✔

### Suites
| File | Focus |
|---|---|
| `test/db/channel_inbound_monotonic.db.test.js` | stale events + monotonic status enforcement over the DB-backed booking store |
| `test/db/channel_queue_persistence.db.test.js` | durable queue + DLQ: idempotency, concurrency, retry, replay |
| `test/db/multitenant_security.db.test.js` | RLS isolation, cross-tenant rejection, tenant-escape, cross-property finding |

---

## 4. Validation Matrix

| Area | Check | Mechanism | Result |
|---|---|---|---|
| Monotonic status | higher rank advances + persists (`version` bumps) | `channelInboundService` over DB `booking_store` | ✅ |
| Stale events | equal/lower rank is a no-op (row unchanged) | rank guard + row re-read | ✅ |
| Cancel safety | CANCELLED after CHECKED_IN rejected, row unmutated | exception path | ✅ |
| Idempotency (ingest) | duplicate event → 1 row | natural key `(tenant,channel,external_ref)` | ✅ |
| Idempotency (queue) | duplicate PENDING deduped | partial-unique `WHERE status='PENDING'` | ✅ |
| Concurrency | 2 concurrent claimers get distinct jobs | `FOR UPDATE SKIP LOCKED`, 2 tenant txns | ✅ |
| Retry | `markFailed` ++attempts; FAILED key re-enqueable | `attempts` column + partial-unique | ✅ |
| DLQ coalescing | same `(…,generation)` coalesces (++attempts) | `uq_cdls_coalesce` | ✅ |
| Replay | `reprocess_requested` flips true | DLQ update | ✅ |
| Constraints | bad `status`/`action` rejected | `CHECK` (23514) | ✅ |
| RLS read | tenant A sees only A; none → 0 | `app.tenant_id` visibility | ✅ |
| RLS write | cross-tenant insert rejected | RLS `WITH CHECK` (42501) | ✅ |
| Tenant escape | forged/garbage `app.tenant_id` → 0 rows | parameterized GUC | ✅ |
| Cross-property | tenant sees all its properties (documented) | DISTINCT property_id | ✅ (finding) |

---

## 5. Concurrency Findings

- **`FOR UPDATE SKIP LOCKED` is correct.** Two concurrent `dequeue()` calls in separate tenant transactions claimed **distinct** jobs (no double-processing); a follow-up claim correctly returned `null` once the controlled set was drained.
- **Duplicate prevention holds at the engine level.** The partial-unique index `(tenant_id, reservation_id, action) WHERE status='PENDING'` makes a duplicate enqueue a no-op `{deduped:true}` — proven by row count, not just the return value.
- **Retry escalation** is observable: `markFailed` increments `attempts` and sets `FAILED`; because the partial-unique only constrains `PENDING`, a failed job can be re-enqueued for another attempt.
- **Replay / DLQ** behave per design: terminal failures coalesce by `dedupe_generation` (incrementing `attempts` rather than duplicating), and `requestReprocess` flags rows for replay.
- **Monotonic ordering** is enforced in application code over persisted state: rank `PENDING<CONFIRMED<CHECKED_IN<CHECKED_OUT`, with `CANCELLED` terminal and cancel-after-presence rejected.

---

## 6. RLS Findings

- RLS binds correctly under the **non-superuser** owner role because the tables declare `FORCE ROW LEVEL SECURITY`. Without a tenant context (`app.tenant_id` unset/NULL) the predicate is NULL → **zero rows**.
- Tenant A context returns exactly A's rows; B exactly B's; reads of a known B id under A context return nothing.
- Cross-tenant **writes** are rejected by the policy's `WITH CHECK` (SQLSTATE `42501`).
- **FINDING (by design, not a defect):** RLS is **tenant-grain**, not property-grain — a tenant context sees rows across *all* of its properties. Property isolation is enforced at the **application layer** (`WHERE property_id`). This matches the one-DB-per-on-prem-install model. **No schema redesign warranted.**

---

## 7. Security Findings

- **Tenant isolation:** enforced by the database, not just app code (proven by visibility outcomes under a non-bypassing role).
- **Cross-tenant rejection:** writes that violate the tenant predicate fail at the engine (`42501`).
- **Tenant-escape prevention:** `app.tenant_id` is set via a **parameterized** `set_config`, so injection-style values (`x' OR '1'='1`) and forged UUIDs are treated as literals that match nothing → 0 rows. No bypass observed.
- **Audit integrity:** append-only posture is defined in the schema (`REVOKE UPDATE,DELETE` on `audit_events`/`event_store`/`ledger_entries` from PUBLIC; FORCE RLS). The Phase-29 suites do not mutate audit tables; append-only enforcement under a restricted role is covered by the legacy `rls.db.test.js` (see §12).

---

## 8. Performance Findings

| Observation | Value |
|---|---|
| Total DB suite runtime (19 tests, serial) | **≈ 3.19 s** |
| First test per file (pool connect + `before` seed) | ~190–200 ms |
| Steady-state data-level tests | ~3–17 ms each |
| Concurrency test (2 tenant txns + SKIP LOCKED) | ~100 ms |
| Migration provisioning (48 files, one-time) | < 1 s total |

- **Queue throughput:** individual enqueue/dequeue/markFailed operations complete in single-digit milliseconds; no contention observed on the partial-unique or `SKIP LOCKED` paths.
- **Bottlenecks:** none discovered. The only non-trivial cost is per-file connection-pool warm-up (~0.2 s), which is test-harness overhead, not a production path.

---

## 9. Exact Test Counts

**Phase-29 DB suites (real PostgreSQL):**
```
channel_inbound_monotonic.db.test.js  : 5  pass
channel_queue_persistence.db.test.js  : 7  pass
multitenant_security.db.test.js       : 7  pass
                                        ── 19 pass / 0 fail / 0 skipped
total runtime ≈ 3.19 s
```

**Backend regression (standard `npm test`, DB files skip in no-DB mode):**
```
642 tests — 636 pass / 0 fail / 6 skipped
```
(The 6 skips are the 6 `*.db.test.js` files registering their skip placeholder without `TEST_DATABASE_URL`.)

---

## 10. Failure Discovered & Remediation

- **1 failure on the first run**, in the SKIP-LOCKED concurrency test: it asserted "no PENDING jobs remain" but an earlier test in the same file had left a `PENDING` row, so a third job remained.
- **Root cause:** a **test-design bug** (uncontrolled precondition / cross-test state), *not* a product defect — the queue's `SKIP LOCKED` / dequeue logic behaved correctly.
- **Remediation:** the concurrency test now clears its own starting state with a data-level `DELETE` before enqueuing its two jobs. Re-run: **19/19 pass.** No product/schema change.
- Consistent with the directive: *"if a test requires schema reset / role creation / escalation, treat it as a test-design bug."* No such requirement was introduced.

---

## 11. Regression Summary

| Suite | Before (Phase 28) | After (Phase 29) |
|---|---|---|
| Backend (`npm test`) | 639 tests — 636 pass / 0 fail / 3 skip | **642 tests — 636 pass / 0 fail / 6 skip** |
| Phase-29 DB suites (real PG) | n/a | **19 pass / 0 fail** |
| Frontend | 28 pass / 0 fail | 28 pass / 0 fail (untouched) |

Pass count is unchanged at **636** → **zero regressions**. The delta is +3 skip placeholders (the 3 new DB files in no-DB mode) and the new 19-test real-PG suite.

---

## 12. Risk Assessment

| Risk | Severity | Status / Mitigation |
|---|---|---|
| Persistence paths validated only by fake client | **Resolved** for the channel inbound/queue/DLQ/sync-state paths — now proven on real PG |
| RLS not actually enforced by DB | **Low** — proven under a non-bypassing role (FORCE RLS) |
| Property-level data leak within a tenant | **Low / by design** — RLS is tenant-grain; property isolation is app-level (documented §6) |
| Legacy DB tests violate the boundary | **Medium (test-only)** — `schema_and_constraints.db.test.js`, `rls.db.test.js`, `finance_flows.db.test.js` still call the harness `freshSchema()` (`DROP SCHEMA`) + `setupAppRole()` (`CREATE ROLE`) and assume a **superuser** connection. Under the strict non-superuser/no-DDL boundary they are **test-design bugs** and were **not executed** in this compliant run. Recommended: port them to the same data-level pattern (follow-up, no product change). |
| AI Confirmation Queue (Phase 27.3) persistence | **N/A** — it is in-memory by design (no DB layer); its retry/DLQ/replay/idempotency are covered by `aiConfirmation.test.js`. No schema exists to validate; adding one would be a feature, explicitly out of scope. |

---

## 13. Production Readiness Verdict

**READY (persistence-critical paths).** The durable channel persistence layer — inbound monotonic ingestion, queue idempotency/concurrency/retry, DLQ/replay, and multi-tenant RLS isolation — is validated against real PostgreSQL 18.4 with **no fake-client-only coverage remaining on those paths** and **zero schema mutation during test runtime**. No defects in product code were found; the single failure was a test-design issue and was fixed. No schema redesign was required.

**Caveats / follow-ups (non-blocking):**
1. Port the three legacy `*.db.test.js` files off `freshSchema()`/`setupAppRole()` to the data-level boundary (test-only rework).
2. Production currently connects as the DB owner; to make RLS enforce in production (not just app-side `WHERE tenant_id`), run the app under a non-superuser, `NOBYPASSRLS` role — already proven viable here.

---

## 14. Scope Boundary (per directive)

Only validation, evidence collection, and the one test-design fix were performed. **No** new features, schema redesign, architecture changes, UI, AI, or OTA expansion. **Awaiting approval before Phase 30.**
