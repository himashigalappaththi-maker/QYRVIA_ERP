# QYRVIA Phase 24 — Step 8: Persistence Foundation (B1–B3) — Implementation Report

**Mode:** Implementation (foundation only). **Scope:** interfaces + migrations (definition only) +
`CHANNEL_PERSISTENCE` flag + DB repos + DI wiring + tests. **All dormant behind default `memory`.**

---

## 1. Implementation summary
Built the persistence foundation from the approved Step 7 (S4) design, **without changing runtime
behavior**:
- **B1 — Interfaces + DB repos behind one contract.** A contract method-set per store
  (`contracts.js`), in-memory implementations (`memoryStores.js`, the queue reusing the S3
  `channelSyncQueue` for a single source of truth), and DB implementations (`dbStores.js`,
  parameterized SQL matching migration 0045).
- **B2 — Migrations (definition only).** `0045_channel_persistence.sql` defines all five stores with
  `tenant_id`/`property_id`, audit fields, RLS (`ENABLE`+`FORCE`, `app.tenant_id` policy), and the
  exact idempotency anchors. **Not run by the no-DB test suite; applied only via `migrate.js up`.**
- **B3 — Flag + DI.** `CHANNEL_PERSISTENCE = memory | dual | db` (default `memory`) in `env.js`; a
  factory (`persistence/index.js`) selects the implementation set; `index.js` constructs it at boot
  (`db: db.pool`) and exposes it via DI. **No caller consumes it** (subscriber/queue unchanged) →
  runtime identical.

Default `memory` means: no DB calls, no behavior change, no new runtime path.

## 2. Files created
| File | Purpose |
|---|---|
| `server/src/db/migrations/0045_channel_persistence.sql` | 5 tables + RLS + indexes (definition only) |
| `server/src/channel-manager/persistence/contracts.js` | Contract method-sets + `assertImplements` |
| `server/src/channel-manager/persistence/memoryStores.js` | In-memory impls (default); queue reuses S3 |
| `server/src/channel-manager/persistence/dbStores.js` | DB repos (dormant; pg-compatible `db.query`) |
| `server/src/channel-manager/persistence/index.js` | Flag resolution + dual wrapper + DI factory |
| `server/test/channelPersistence.test.js` | 14 tests (compliance/CRUD/idempotency/migration/flag) |

## 3. Files modified
| File | Change |
|---|---|
| `server/src/config/env.js` | Added `CHANNEL_PERSISTENCE` (default `memory`) |
| `server/src/index.js` | DI-only: construct `channelPersistence` at boot + add to `createApp` deps |

**No** changes to: channelSubscriber, channelSyncQueue behavior, routes, API, PMS, OTA, UI, frontend.

## 4. Migration list
- `0045_channel_persistence.sql` — `channel_booking_store`, `channel_mapping_store`,
  `channel_sync_queue_store`, `channel_dead_letter_store`, `channel_sync_state_store`.
  Idempotency anchors: `UNIQUE(tenant_id, channel, external_ref)`;
  partial `UNIQUE(tenant_id, reservation_id, action) WHERE status='PENDING'`;
  `UNIQUE(tenant_id, reservation_id, action, dedupe_generation)`; sync-state PK
  `(tenant_id, channel, resource_key)`. RLS per table.

## 5. Test results
| Suite | Before (S3) | After (B1–B3) |
|---|---|---|
| Backend `npm test` | 475 pass / 0 fail / 3 skip (478) | **489 pass / 0 fail / 3 skip (492)** |

New: 14 tests in `channelPersistence.test.js` — interface compliance (memory + db), repository CRUD
(memory), idempotency constraints (booking/queue/dead-letter), migration validity (static parse of
0045), flag-selection logic (memory default, db-without-client fallback, db, dual mirror). All green.

## 6. Rollback procedure
- **Instant (config):** unset `CHANNEL_PERSISTENCE` or set `memory` — already the default, so no action
  needed; the foundation is dormant.
- **Code rollback:** delete `server/src/channel-manager/persistence/*` and
  `server/test/channelPersistence.test.js`; revert the `env.js` flag line and the two `index.js`
  DI lines. Leave migration `0045` unapplied (never run `migrate.js up`) or, if applied to a DB,
  drop the five `channel_*` tables (no other object references them).
- All reverts are isolated; nothing else imports the new modules.

## 7. Risk assessment
| Risk | Level | Mitigation |
|---|:---:|---|
| Behavior change at boot | **NONE** | Default `memory`; DI constructed but unconsumed; tests prove identical counts (+ additive only) |
| Migration auto-applied unexpectedly | LOW | `migrate.js` only runs on explicit `up` against a real DB; no-DB tests skip it; additive tables, no FKs from existing tables into new ones |
| DB repo correctness (untested vs real PG) | MED | Repos unit-tested via fake client for interface + SQL wiring; real-PG CRUD validated at B4 activation; SQL columns matched to 0045 |
| RLS not enforced in raw-query db-mode | MED (future) | Documented: B4 must route db-mode through `client.withTenant` (SET `app.tenant_id`); not activated now |
| Dual divergence | LOW (future) | Dual mirror is best-effort + logged; memory authoritative; reconciled at B4+ parity gate |

## 8. Constraints honored
✅ No OTA connectivity · ✅ No Booking Engine · ✅ No PMS modifications · ✅ No UI/frontend changes ·
✅ No worker/background processing · ✅ No replay · ✅ No channelSubscriber changes · ✅ No queue
behavioral changes · ✅ No API/route changes. **UI protection rule:** no UI file was touched (N/A).

**STOP after B1–B3.** Not started: replay, durable queue workers, OTA adapters, webhook ingestion,
Booking Engine, Revenue Forecasting, CRM, AI WhatsApp Agent. Awaiting approval to continue beyond B3.
