# QYRVIA ERP — Phase 51: QYRVIA Connect Correction

**Version:** V35  
**Date:** 2026-07-09  
**Status:** COMPLETE — 896 pass / 0 fail / 13 skipped. Awaiting commit approval.  
**Scope:** Channel Manager — canonical channel code rename (`QTCN` → `QYRVIA_CONNECT`) + backward-compat legacy alias. Two waves across two sessions.

> Phase 51 corrects the internal identity of the QYRVIA-owned B2B distribution channel. Wave 1 renamed the internal metadata field `internal` → `qyrvia_owned`. Wave 2 promoted the canonical channel code from `QTCN` to `QYRVIA_CONNECT`, retaining `QTCN` as a backward-compatible legacy alias so old queued jobs continue to resolve correctly.

Related reports: `QYRVIA_PHASE24_STEP_B8B3_QTCN_OUTBOUND_SYNC_REPORT.md`, `QYRVIA_PHASE30_2_OTA_TRANSPORT_REPORT.md`.

---

## 1. Objective

The channel previously known by the short code `QTCN` is QYRVIA's own B2B OTA/distribution platform — not a third-party OTA. Calling it `QTCN` was misleading and inconsistent with the `QYRVIA_CONNECT` display name already used in the UI. Phase 51 makes the canonical code match the product identity everywhere: in the type constants, DB rows, API/DB output, adapter initialization, sync service defaults, and environment config, while preserving a legacy alias so in-flight queued work is not broken.

---

## 2. Wave 1 — Metadata Field Rename (`internal` → `qyrvia_owned`)

Completed in the prior session.

**What changed:**
- The boolean metadata field `internal` on the QYRVIA Connect channel definition was renamed to `qyrvia_owned` across all channel manager files to more accurately describe what the flag means: that this channel is owned and operated by QYRVIA, not that it is restricted to internal traffic only.

**Rule enforced:** `qyrvia_owned: true` does not imply the channel is hidden from the channel registry or blocked from external B2B partners — it asserts QYRVIA's ownership of the platform.

**Test result after Wave 1:** 895 pass / 0 fail.

---

## 3. Wave 2 — Canonical Code Rename (`QTCN` → `QYRVIA_CONNECT`)

Completed in this session. 28 files modified, 2 files added.

### 3.1 Rules Enforced

| Rule | Implementation |
|---|---|
| Canonical code is `QYRVIA_CONNECT` | All new code, API output, DB writes, and test assertions use `QYRVIA_CONNECT` |
| `QTCN` kept as legacy alias | Retained in `CHANNELS` constant and `realProcessor.js` guard for backward compatibility with old queued jobs |
| Display name stays `QYRVIA Connect` | No UI-visible string changed |
| Description | "QYRVIA-owned B2B OTA/distribution platform" |
| Not marked "internal only" | Corrected in all definitions |

### 3.2 Files Changed

**Type constants**

- `server/src/channel-manager/types.js` — Added `QYRVIA_CONNECT: 'QYRVIA_CONNECT'`; `QTCN: 'QTCN'` retained as legacy alias alongside it.

**Channel definitions**

- `server/src/channel-manager/defaultChannels.js` — `code: 'QTCN'` → `code: 'QYRVIA_CONNECT'`.

**Adapter**

- `server/src/channel-manager/adapters/QTCNAdapter.js` — Constructor now calls `super(CHANNELS.QYRVIA_CONNECT)`; `mapToCanonical` sets the `channel` field to `CHANNELS.QYRVIA_CONNECT`.

**Processor**

- `server/src/channel-manager/realProcessor.js` — Dispatch guard now accepts `QYRVIA_CONNECT || QTCN` (covers legacy queued jobs); all output emitted as `CHANNELS.QYRVIA_CONNECT`.

**Sync services and environment**

- `server/src/channel-manager/sync/index.js` — Default real-channels set updated to `'QYRVIA_CONNECT'`.
- `server/src/channel-manager/channelSyncService.js` — Same default update.
- `server/src/env.js` — Default value of `CHANNEL_REALSYNC_CHANNELS` updated to `'QYRVIA_CONNECT'`.

**DB migration**

- `server/migrations/0056_rename_qtcn_channel_code.sql` — Idempotent `UPDATE` migrating any existing DB rows where `code = 'QTCN'` to `code = 'QYRVIA_CONNECT'`. The `WHERE code = 'QTCN'` predicate makes the migration safe to re-run.

**Tests (13 files updated)**

- Existing test files: all assertions referencing `'QTCN'` as the canonical code updated to `'QYRVIA_CONNECT'`.
- `server/test/phase51_qyrvia_connect.test.js` — New test file. Covers: canonical code resolution, legacy alias backward compatibility (old queued jobs with `QTCN` still dispatch to `QYRVIA_CONNECT`), `mapToCanonical` output shape, display name correctness, `qyrvia_owned` flag.

---

## 4. Migration Note

**Migration file:** `server/migrations/0056_rename_qtcn_channel_code.sql`

This migration must be applied before the server is started after this branch is merged. It is **idempotent** — safe to run more than once. It targets only rows where `code = 'QTCN'` so it will no-op on a fresh installation that never had the old code.

If a deployment has in-flight queue entries referencing the old `QTCN` code, those will continue to resolve because `realProcessor.js` accepts both codes in its guard. No manual data repair is required beyond running the migration.

---

## 5. Test Results

| Suite | Pass | Fail | Skip | Notes |
|---|---|---|---|---|
| Wave 1 baseline (`npm test`) | 895 | 0 | — | After `internal` → `qyrvia_owned` rename |
| Wave 2 full regression (`npm test`) | 896 | 0 | 13 | After canonical code rename; net +1 from new phase51 test suite |

All 13 skipped tests are pre-existing skips unrelated to this phase (consistent with the skip count in prior phases).

---

## 6. Security Constraints Confirmed

The following security constraints were verified to remain enforced after both waves:

| Constraint | Status |
|---|---|
| No OTA channel auto-promoted to `live` status | Confirmed — live status requires explicit `PATCH /registry/:channel/status` admin action |
| HTTP transport disabled by default | Confirmed — `CHANNEL_HTTP_ENABLED=false` default unchanged |
| Real dispatch requires explicit opt-in | Confirmed — `CHANNEL_WORKER_REAL=true` must be set in environment for real dispatch to activate |
| QYRVIA Connect not "internal only" | Corrected — the `qyrvia_owned` flag does not restrict external B2B partner access |

---

## 7. Backward Compatibility

- Any code or queued job that references the string `'QTCN'` (old canonical code) will continue to work. `CHANNELS.QTCN` remains exported from `types.js` and `realProcessor.js` accepts it as an alias.
- `QTCNAdapter.js` retains its filename. A rename of the adapter file itself is deferred — it is a pure cosmetic change and carries no functional risk or benefit at this stage.
- The migration is additive (UPDATE only, no DROP, no structural change).

---

## 8. Residual Items / Follow-ups

| Item | Priority | Notes |
|---|---|---|
| Rename `QTCNAdapter.js` → `QyrviaConnectAdapter.js` | Low | Cosmetic only; the legacy filename does not affect correctness. Deferred to avoid unnecessary churn before commit approval. |
| Remove `CHANNELS.QTCN` legacy alias | Future | After all queued jobs have been drained and any external config referencing `QTCN` has been updated. Requires a separate deprecation notice phase. |
| Legacy DB migration validation on staging | Before production deploy | Confirm `0056` applies cleanly against a real snapshot of the production schema. |

---

## 9. Commit Status

**Not yet committed.** All changes are staged and awaiting user approval. To apply:

1. Approve and merge the branch.
2. Run `server/migrations/0056_rename_qtcn_channel_code.sql` against the target database.
3. Confirm `npm test` returns 896 pass / 0 fail / 13 skip on the target environment.
