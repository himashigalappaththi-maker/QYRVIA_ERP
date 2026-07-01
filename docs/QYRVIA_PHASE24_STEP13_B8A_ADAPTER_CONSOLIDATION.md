# QYRVIA Phase 24 — Step 13 (B8-A): OTA Adapter Framework Consolidation

**Mode:** Implementation. **Goal:** unify the duplicate adapter architecture into ONE canonical
framework before any real OTA integration. **No real OTA connectivity / credentials / API calls /
webhooks** were added.

---

## 1. Adapter code inventory (pre-consolidation)

| Group | Files | Contract | Status |
|---|---|---|---|
| **Live class-based** | `adapters/base/OTAAdapter.js` (base + `assertImplements`) | 6-method: `pushRates, pushInventory, pullBookings, confirmBooking, cancelBooking, mapToCanonical` + `channel` | **KEEP** (now bridged) |
| Live adapters | `adapters/{qyrcn/QTCNAdapter, bookingcom/BookingComAdapter, agoda/AgodaAdapter, expedia/ExpediaAdapter, airbnb/AirbnbAdapter}.js` | as above (mocks) | **KEEP** (migrated via bridge) |
| Live wiring | `core/ChannelManagerCore.js` `_adapters` Map (registerAdapter) | 6-method | KEEP (runtime; canonical migration is a later step) |
| **Orphaned framework** | `adapters/base/assertAdapter.js` (Phase 10.2 base + `assertAdapter`) | 5-method: `pullAvailability, pushRates, pushInventory, createBooking, cancelBooking` | **DEPRECATED** |
| Orphaned registry | `registry/adapterRegistry.js`, `registry/adapterFactory.js` | filesystem discovery of `adapters/otas/*` | **DEPRECATED** |
| Orphaned adapters | `adapters/otas/*.adapter.js` (8: booking.com, agoda, expedia, airbnb, makemytrip, googletravel, tripadvisor, qytn) | 5-method | **DEPRECATED** (consumed only by `ota_scale.test.js`) |
| Tests | `channel_adapter_contract`, `channel_*`, `ota_scale` | mixed | unchanged + green |

**Two registration systems existed** (ChannelManagerCore map for live + filesystem registry for
orphaned). B8-A introduces the **single canonical registry** and deprecates the orphaned one.

## 2. Files created (unified framework)
| File | Purpose |
|---|---|
| `adapters/framework/CanonicalOTAAdapter.js` | The single 8-method contract + `CANONICAL_METHODS` |
| `adapters/framework/AuthStrategy.js` | Abstract `AuthStrategy` + `NoopAuthStrategy` (credentials_ref only; no secrets) |
| `adapters/framework/adapterValidator.js` | interface / lifecycle / normalization validation |
| `adapters/framework/adapterRegistry.js` | Single canonical registry (compliance-enforcing) |
| `adapters/framework/legacyBridge.js` | Migrates live 6-method mocks → canonical 8-method contract |
| `adapters/framework/index.js` | Public entry + `buildCanonicalAdapterRegistry()` (5 bridged live mocks) |
| `test/channelAdapterFramework.test.js` | 9 tests |
| `docs/QYRVIA_PHASE24_STEP13_B8A_ADAPTER_CONSOLIDATION.md` | this report |

## 3. Files modified (deprecation markers only — behavior preserved)
| File | Change |
|---|---|
| `registry/adapterRegistry.js` | `@deprecated` banner + `DEPRECATED: true` export |
| `registry/adapterFactory.js` | `@deprecated` banner |
| `adapters/base/assertAdapter.js` | `@deprecated` banner + `DEPRECATED: true` export |

No functional code changed in the deprecated files; they remain fully working (compatibility).

## 4. Deprecated components
- `channel-manager/registry/adapterRegistry.js` (filesystem discovery)
- `channel-manager/registry/adapterFactory.js`
- `channel-manager/adapters/base/assertAdapter.js` (Phase 10.2 5-method `OTAAdapter` + `assertAdapter`)
- `channel-manager/adapters/otas/*.adapter.js` (8 files — implicitly, via the deprecated registry)

Marked, **not removed**. Still exercised by `ota_scale.test.js` (kept green).

## 5. Canonical contract (the unified standard)
```
channel                              identity
auth: AuthStrategy                   credentials_ref only — core never sees secrets
init()        -> Promise<void>       lifecycle
health()      -> Promise<{ ok }>     gate routing (degraded => park jobs)
close()       -> Promise<void>
normalizeBooking(raw) -> CanonicalBooking
pushReservation(booking) -> Promise<ack>
pushAvailability(inv)    -> Promise<ack>
pushRateUpdate(rate)     -> Promise<ack>
handleWebhook(req)       -> { verified, events: CanonicalBooking[] }
```

**Mock migration mapping (legacyBridge):** `mapToCanonical → normalizeBooking`,
`pushInventory → pushAvailability`, `pushRates → pushRateUpdate`,
`confirm/cancelBooking → pushReservation`, `pullBookings/raw → handleWebhook`;
`init/health/close` are mock no-ops/`{ok:true}`.

## 6. Test additions (9) — all required scenarios
adapter registration (+ duplicate rejection) · interface enforcement (missing method fails
validation + registration) · canonical 8-method advertisement · lifecycle enforcement (bad `health`
flagged) · registry resolution (canonical registry loads 5 bridged live mocks; unknown channel
throws) · normalization validation (canonical booking shape; missing fields flagged) · full
`validateAll` per adapter · deprecated-framework compatibility (still functional + `DEPRECATED` flag)
· bridge delegation (push/normalize/webhook; no secrets).

## 7. Before/after test counts
**Backend: 505 pass / 0 fail / 3 skip (508) → 514 pass / 0 fail / 3 skip (517).** +9, zero regressions.
`ota_scale.test.js` (deprecated path) remains green.

## 8. Migration strategy
| Stage | Action | Status |
|---|---|---|
| M1 | Define canonical 8-method contract + AuthStrategy + validator + single registry | ✅ done (B8-A) |
| M2 | Bridge live mock adapters into the canonical registry (no connectivity) | ✅ done (B8-A) |
| M3 | Mark orphaned `otas`/`registry`/`assertAdapter` deprecated; keep functional | ✅ done (B8-A) |
| M4 | (later) Migrate `ChannelManagerCore` to consume `buildCanonicalAdapterRegistry()` | deferred |
| M5 | (later) Port any still-wanted `otas` adapters (makemytrip/google/tripadvisor) to the canonical contract | deferred |
| M6 | (later) Remove the deprecated framework + `ota_scale.test.js` once nothing references it | deferred |
| M7 | (later) Implement real `AuthStrategy` + connectivity per adapter (B8-B+) | deferred — **out of scope here** |

## 9. Risk assessment
| Risk | Level | Mitigation |
|---|:---:|---|
| Breaking the live pipeline | **NONE** | ChannelManagerCore untouched; framework is additive; 514/0 |
| Breaking the orphaned tests | **NONE** | Deprecated files functionally unchanged; `ota_scale` green |
| Two registries lingering | LOW | Canonical is now the documented single source; orphaned marked `DEPRECATED`; removal is M6 |
| Bridge semantics drift | LOW | Bridge delegates to existing mock methods; validated by `validateAll` + bridge test |
| Secret leakage | **NONE** | `AuthStrategy` stores only `credentials_ref`; mocks use `NoopAuthStrategy` (ref=null) |

## 10. Rollback plan
- The framework is **purely additive** and unconsumed by runtime (no `index.js`/route/API change), so
  it is inert until a future step wires it.
- **Code rollback:** delete `adapters/framework/*` and `test/channelAdapterFramework.test.js`; revert
  the three `@deprecated` banner edits (`registry/adapterRegistry.js`, `registry/adapterFactory.js`,
  `adapters/base/assertAdapter.js`). Nothing else imports the framework.

## 11. Constraints honored
✅ No OTA connectivity / credentials / API calls / webhooks · ✅ No PMS / Booking Engine / Revenue /
CRM / WhatsApp · ✅ No frontend / route / API changes. **UI protection rule:** no UI file touched (N/A).

**STOP after B8-A.** Not started: real OTA connectivity, OTA credentials, OTA webhooks, Booking
Engine, AI WhatsApp Agent, Revenue Forecasting, CRM.
