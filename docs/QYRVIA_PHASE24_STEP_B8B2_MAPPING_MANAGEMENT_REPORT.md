# QYRVIA Phase 24 — B8-B2: Channel Mapping Management — Validation Report

**Mode:** Implementation (mapping domain only). **Internal data only — no OTA calls, no network, no
PMS / worker / API / UI / frontend changes.** Additive + dormant (DI only; default `memory`).

---

## 1. What was built
A mapping management layer over `channel_mapping_store` that, on every change, records a monotonic
**`mapping_version`**, an **append-only history** snapshot, and a **SAFE audit event** (metadata only —
never credentials/secrets):
- **PMS room_type ↔ OTA room** (`ota_room_id`), **PMS rate_plan ↔ OTA rate plan** (`ota_rate_plan_id`),
  **property ↔ OTA property** (`ota_property_id`), plus `enabled` toggling.
- History exists so a booking can be reconciled against the mapping that was **live at ingest time**
  (disputes / late webhooks).

## 2. Files created
| File | Purpose |
|---|---|
| `db/migrations/0048_channel_mapping_versioning.sql` | `mapping_version` + `ota_property_id` columns + `channel_mapping_history` table (RLS) |
| `channel-manager/mapping/channelMappingHistoryStore.memory.js` | Append-only history (default) |
| `channel-manager/mapping/channelMappingHistoryStore.db.js` | DB history repo (dormant) |
| `channel-manager/mapping/channelMappingService.js` | Versioning + history + audit orchestration |
| `channel-manager/mapping/index.js` | `buildChannelMappingManagement()` DI factory |
| `test/channelMappingManagement.test.js` | 9 tests |
| `docs/QYRVIA_PHASE24_STEP_B8B2_MAPPING_MANAGEMENT_REPORT.md` | this report |

## 3. Files modified
| File | Change |
|---|---|
| `channel-manager/persistence/dbStores.js` | mapping UPSERT now carries `ota_property_id` + `mapping_version` (additive; db-mode coherence) |
| `index.js` | DI: build `channelMapping` (reuses `channelPersistence.mapping`); add to `createApp` deps |

No change to: adapters, worker, queue, routes, API, PMS, credential domain, frontend/UI. The memory
mapping store (B1-B3) is reused as-is (it merges arbitrary fields, so versioning rides on it).

## 4. Migration
- `0048_channel_mapping_versioning.sql` — `ALTER channel_mapping_store ADD mapping_version (DEFAULT 1),
  ota_property_id`; `CREATE TABLE channel_mapping_history (… mapping_version, change_type
  CHECK(CREATED|UPDATED|DISABLED|ENABLED), actor_id, changed_at)` with RLS `ENABLE`+`FORCE` +
  `app.tenant_id` policy. **Definition only** — applied only via `migrate.js up`; no-DB tests skip it.

## 5. Validation
| Check | Result |
|---|---|
| Backend suite (before → after) | **525 / 0 / 3 (528) → 534 / 0 / 3 (537)** (+9, zero regressions) |
| Versioning correct | ✅ create=v1, update=v2, disable=v3, enable=v4 (monotonic) |
| History append-only + ordered | ✅ one snapshot per change; `change_type` accurate; `actor_id` captured |
| Audit safe | ✅ metadata only (`tenant_id, channel, room_type_id, mapping_version`); no `credentials_ref`/secret |
| RLS / tenant isolation | ✅ cross-tenant `getMapping`/`getHistory` returns nothing |
| Adapters / worker / API unchanged | ✅ |

**Test coverage (9):** create (v1 + CREATED history + audit) · update (v2 + partial-merge preserved) ·
disable→enable (v2/v3 + DISABLED/ENABLED history + audit) · missing-mapping guard · rate-plan +
property fields persist · `listMappings` filter · RLS isolation · audit-no-secret · migration validity.

## 6. Risk assessment
| Risk | Level | Mitigation |
|---|:---:|---|
| Runtime behavior change | **NONE** | DI only, unconsumed; default `memory`; 534/0 |
| Secret/credential leakage via audit/history | **LOW** | Audit emits metadata only; history stores mapping fields (incl. `credentials_ref` pointer, never a secret) |
| db-mode column drift | LOW | `dbStores` mapping UPSERT updated to the new columns; both default to safe values |
| Migration auto-apply | LOW | Additive; runs only on explicit `migrate.js up`; tests skip it |
| Schema conflation (rate plan on room_type row) | LOW (noted) | Matches 0045 design; finer decomposition is a future schema refinement if needed |

## 7. Rollback plan
- **Instant:** nothing consumes `channelMapping` at runtime ⇒ inert.
- **Code:** delete `channel-manager/mapping/*` and `test/channelMappingManagement.test.js`; revert the
  `dbStores.js` UPSERT columns and the `index.js` DI lines; leave migration `0048` unapplied (or drop
  `channel_mapping_history` + the two added columns). Nothing else imports the mapping management layer.

## 8. Constraints honored
✅ Internal data only · ✅ No OTA network/calls/webhooks · ✅ No PMS / worker / API / route changes ·
✅ No frontend / UI changes · ✅ No Booking Engine / CRM / Revenue / AI work. **UI protection rule:**
no UI file touched (N/A).

**STOP after B8-B2.** Awaiting approval for B8-B3 (QTCN-first real outbound sync; per the blueprint
roadmap §7, QTCN is the safest first real edge — internal engine, no third party).
