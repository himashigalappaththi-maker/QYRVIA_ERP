# QYRVIA ERP — Phase 28: Channel Manager Core → Canonical Registry Migration

**Version:** V35
**Date:** 2026-06-25
**Status:** ✅ Implemented + fully validated. `CHANNEL_CANONICAL_CORE` default ON (migrated). Awaiting approval before any Phase 29 work.

---

## 1. Summary

`ChannelManagerCore` previously kept its own ad-hoc adapter `Map` gated on the
**legacy 6-method contract** (`adapters/base/OTAAdapter`). The outbound sync layer
(`channel-manager/sync`) had already moved to the **canonical adapter framework**
(`adapters/framework/*`), leaving two parallel adapter worlds and a deprecated
filesystem-discovery registry (`registry/*`).

Phase 28 migrates `ChannelManagerCore` onto the **canonical framework registry**, so
the canonical contract is now the **single source of truth for adapters across the
entire system**. The migration is **behavior-preserving** and **reversible by config**.

### Hard guarantees preserved
- PMS remains the source of truth; **no PMS/OTA writes changed, no schema change, no UI change**.
- The HTTP surface (`/api/channel/*`) and all response shapes are **identical**.
- `SyncEngine`, `QueueManager`, `RateService`, `InventoryService`, `BookingService`,
  `ConflictResolver` are **untouched**.
- **Rollback is config-only:** `CHANNEL_CANONICAL_CORE=false` restores the legacy
  registry path. No code was removed.

---

## 2. Architecture — Before / After

### Before
```
                  ┌──────────────────────────────┐
 /api/channel ──▶ │ channel.controller           │
                  └───────────────┬──────────────┘
                                  ▼
                  ┌──────────────────────────────┐
                  │ ChannelManagerCore            │
                  │  _adapters: Map<channel,adp>  │  gate: adapters/base/OTAAdapter
                  │  (6-method legacy contract)   │       .assertImplements (6 methods)
                  └───────────────┬──────────────┘
                                  ▼ legacy methods (pushRates/pullBookings/…)
                  ┌──────────────────────────────┐
                  │ BookingComAdapter, QTCN, …    │  (class, legacy contract)
                  └──────────────────────────────┘

 channel-manager/sync  ──▶  adapters/framework/* (canonical registry)   ← already canonical
 registry/* (filesystem discovery over adapters/otas/*)                 ← DEPRECATED, only ota_scale.test.js
```

### After
```
                  ┌──────────────────────────────┐
 /api/channel ──▶ │ channel.controller (unchanged)│
                  └───────────────┬──────────────┘
                                  ▼
                  ┌───────────────────────────────────────────────┐
                  │ ChannelManagerCore                            │
                  │  _registry = buildAdapterRegistry()  ◀────────┼─ canonical framework registry
                  │  (canonical 8-method contract + validation)   │  (SAME registry sync/ uses)
                  │  registerAdapter(): canonical OR auto-bridge   │
                  │  _ops(channel): legacy-shaped view for orchestration
                  └───────────────┬──────────────────────────────┘
                          ┌───────┴────────┐
                          ▼                ▼
          bridged legacy adapters     pure-canonical adapters
          (._legacy → orig surface)   (TransportOTAAdapter, …)
                          ▼                ▼
               SyncEngine / services (UNCHANGED)

 registry/* (filesystem discovery)  ← DEPRECATED, retained only for ota_scale.test.js (off the active path)
```

**Net change:** one registry, one canonical contract. Legacy mocks are auto-bridged;
canonical-native adapters (e.g. real-OTA `TransportOTAAdapter`) can now live in the
same core. The core no longer hard-gates on the legacy contract.

---

## 3. Compatibility Matrix

| Surface | Before | After | Compatible? |
|---|---|---|---|
| `/api/channel/sync/rates`,`/sync/inventory` | core → SyncEngine | core → `_ops` → SyncEngine | ✅ identical |
| `/api/channel/bookings/sync`,`/confirm`,`/cancel` | core legacy methods | core → `_ops` (legacy via `._legacy`) | ✅ identical |
| `/api/channel/status`, `/control` | `{channels[{channel,internal,commissionPct}],queue,bookings}` | same shape (read via `_ops`) | ✅ identical |
| `registerAdapter(legacyAdapter)` | accepted (6-method) | accepted (auto-bridged to canonical) | ✅ |
| `registerAdapter(canonicalAdapter)` | rejected (no `pullBookings`…) | accepted (validated 8-method) | ➕ new capability |
| `getAdapter(channel)` | returns legacy adapter | returns canonical adapter (`._legacy` retained) | ⚠️ type changed (no active consumer reads adapter shape) |
| Duplicate channel register | silent overwrite (Map) | rejected (`duplicate channel`) | ⚠️ stricter (boot registers each once) |
| `SyncEngine` / `RateService` / queue / DLQ | — | unchanged | ✅ |
| `channel-manager/sync` (outbound) | canonical | canonical | ✅ unaffected |
| `registry/*` filesystem discovery | deprecated | deprecated, off active path | ✅ retained for `ota_scale.test.js` |

The two ⚠️ rows are intentional improvements (stricter validation) with **no active
consumer affected**: the only callers of the core are the thin controller and the boot
wiring, neither of which inspects the raw adapter object or double-registers a channel.

---

## 4. Migration Strategy

Compatibility-preserving **strangler** swap, config-gated:

1. **Flag** `CHANNEL_CANONICAL_CORE` (default `'true'`). `'false'` selects the legacy path.
2. **Registry swap:** `ChannelManagerCore` constructs `buildAdapterRegistry()` (canonical
   framework) instead of a bare `Map`.
3. **Auto-bridge on register:** `registerAdapter()` accepts a canonical adapter as-is, or
   detects a legacy 6-method adapter and wraps it with `bridgeLegacyAdapter()` — the same
   bridge the outbound sync uses. Malformed adapters still fail loudly at register time.
4. **`_ops(channel)` orchestration view:** resolves a legacy-shaped surface so `SyncEngine`
   and the services stay byte-for-byte unchanged:
   - bridged legacy → its retained `._legacy` (original behavior),
   - pure-canonical → synthesized surface mapping `pushRateUpdate` / `pushAvailability` /
     `pushReservation` / `normalizeBooking` onto the orchestration calls.
5. **Rollback retained:** the legacy `Map` path remains in the class behind the flag.

No change was needed in `index.js` boot wiring (the core reads the flag itself) or in the
controller/routes.

### Subsystem coverage (the 7 named subsystems)
| Subsystem | Touched? | Status |
|---|---|---|
| Webhook ingress (`inbound/webhookIngress`) | No | Uses `sync/` canonical registry; unaffected ✅ |
| Booking ingestion | Core path migrated | Pull via `_ops`; see §5 ✅ |
| Mapping lookups (`mapping/*`) | No | Independent store; unaffected ✅ |
| Credential resolution (`credentials/*`, `SecretProvider`) | No | Resolved in `sync/`; unaffected ✅ |
| Worker processing (`worker/channelQueueWorker`) | No | Lease queue independent; unaffected ✅ |
| Replay (event-sourced fold) | Core path migrated | `channel_event_replay` green ✅ |
| DLQ (`QueueManager.deadLetter`) | No | Reused unchanged; surfaced in `status()` ✅ |

---

## 5. Booking-Ingestion Compatibility Approach

`syncBookings()` is a **pull** operation (`adapter.pullBookings()` → `mapToCanonical` →
idempotent `ingest` → emit `channel.booking_created`). The canonical contract is
**push/webhook-oriented** and has no `pullBookings`. Resolution:

- **Bridged legacy adapters** keep full pull semantics: `_ops()` returns the retained
  `._legacy`, so `pullBookings()`/`mapToCanonical()` behave exactly as before. Dedup,
  conflict detection, event emission, and replay are unchanged (`channel_event_replay`
  passes unmodified).
- **Pure-canonical adapters** (real OTAs) are **webhook-driven**: their `_ops().pullBookings()`
  yields `[]`, so `syncBookings()` returns `pulled:0` and ingests nothing on the pull path.
  Their inbound bookings flow through the existing webhook ingress
  (`inbound/webhookIngress` → idempotent `booking_store` → `commandBus` → PMS), which is the
  intended canonical ingestion route.

This preserves every existing pull-based flow while making the canonical webhook route the
forward path — no double ingestion, no behavior change for current channels.

---

## 6. Removed / Retired Legacy Dependencies

No files deleted (rollback safety). Retired **from the active core path**:
- `adapters/base/OTAAdapter.assertImplements` as the core's **primary** adapter gate —
  now only used for legacy *detection* (to decide whether to bridge) and on the rollback path.
- `registry/adapterRegistry.js` + `registry/adapterFactory.js` (filesystem discovery over
  `adapters/otas/*`) — already `@deprecated`; remain referenced **only** by `ota_scale.test.js`.
  Not on any runtime path. Scheduled for physical removal in a later step once that test is ported.

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Behavior drift in sync/ingest paths | Low | High | `_ops` delegates to `._legacy`; full channel suite (55 tests) green; `SyncEngine` untouched |
| Status/control shape change breaks UI | Very low | Med | Shape asserted identical (`channelCoreMigration` + `channelControlSnapshot`) |
| Duplicate-channel now throws | Very low | Low | Boot registers each channel once; covered by test |
| `getAdapter` return type change | Very low | Low | No active consumer inspects the adapter object |
| Pure-canonical pull returns empty | By design | Low | Documented (§5); webhook ingress is the canonical route |
| Rollback regression | Low | Med | Legacy path retained + tested (`canonicalRegistry:false` parity test) |

Overall: **Low**. The blast radius is a single class; orchestration, queue, DLQ, worker,
mapping, credentials, and webhook subsystems are unchanged.

---

## 8. Rollback Plan

```bash
# .env
CHANNEL_CANONICAL_CORE=false
```

Restores the pre-migration legacy `Map` registry and the 6-method contract gate inside
`ChannelManagerCore`. No code removal, no redeploy of reverted source required. A parity
test (`rollback (canonicalRegistry:false) …`) proves the legacy path still ingests
identically.

---

## 9. Validation — Exact Test Counts

Full validation run before claiming completion.

**Backend** (`server/`, `node --test`):
```
Before Phase 28 (post-27.3):  631 tests — 628 pass / 0 fail / 3 skip
After  Phase 28:              639 tests — 636 pass / 0 fail / 3 skip
Delta: +8 tests (test/channelCoreMigration.test.js), 0 regressions
```

**Channel subsystem subset** (parity guard):
```
channel_event_replay, channel_sync_engine, channel_adapter_contract,
channelAdapterFramework, ota_scale, channel_canonical, channel_booking_conflict,
channelControlSnapshot, channelInboundWebhook ........... 47 pass / 0 fail
channelCoreMigration (new) .............................. 8  pass / 0 fail
                                                          ── 55 pass / 0 fail
```

**Frontend** (`frontend-stitch/`, `node --test`):
```
28 tests — 28 pass / 0 fail / 0 skip   (untouched by this phase)
```

> The 3 backend skips are DB-integration tests (`*.db.test.js`), skipped unless
> `TEST_DATABASE_URL` is set — same as baseline.

---

## 10. Files

**Modified**
- `server/src/config/env.js` — `CHANNEL_CANONICAL_CORE` flag (default `'true'`)
- `server/src/channel-manager/core/ChannelManagerCore.js` — canonical-registry backing,
  auto-bridge, `_ops` orchestration view, flag-gated legacy fallback

**New**
- `server/test/channelCoreMigration.test.js` — 8 migration tests

No changes to controller, routes, sync, inbound, mapping, credentials, worker, persistence,
adapters, schema, or frontend.

---

## 11. Scope Boundary (per directive)

Implemented **only** the Channel Manager Core migration + validation + this report.
**Not** started: AI Hotel Copilot, CRM, Revenue Forecasting, additional OTA vendors, UI
redesign. **Awaiting explicit approval before any Phase 29 work.**
```
