# QYRVIA Phase 24 — B8-B4: Inbound Webhook Ingress — Validation Report

**Mode:** Implementation (inbound ingestion only). **No external network calls, no OTA credentials, no
PMS code changes (commandBus only), no UI/frontend changes.** The new webhook route is **additive and
gated OFF by default** (`CHANNEL_WEBHOOK_ENABLED=false`) ⇒ zero API change unless enabled.

---

## 1. What was built
The inbound path **OTA webhook → adapter → idempotent booking_store → PMS reservation (via commandBus)**:
- **Signature validation** — HMAC-SHA256, timing-safe; signing secret resolved via the SecretProvider
  (B8-B1) by the caller (verifier is pure).
- **`channelInboundService`** — idempotent ingestion: status-rank monotonicity, `booking_store` upsert
  (dedupe by `tenant+channel+external_ref`), `commandBus.dispatch('pms.reservation.create|update')`
  with `external_ref` correlation, `pms_reservation_id` linkback. Command failure ⇒ **link-pending**
  (no duplicate on retry).
- **`webhookIngress`** — resolve adapter → verify signature → `adapter.handleWebhook` (normalize) →
  ingest each canonical booking.
- **Gated route** — `POST /api/channel/webhook/:channel` (RBAC `channel.sync.run`), mounted only when
  the flag is on **and** the inbound pipeline is wired.

## 2. Files created
| File | Purpose |
|---|---|
| `channel-manager/inbound/webhookVerifier.js` | HMAC-SHA256 sign/verify (pure) |
| `channel-manager/inbound/channelInboundService.js` | Idempotent ingest → PMS commandBus + monotonicity |
| `channel-manager/inbound/webhookIngress.js` | Adapter resolve + signature + normalize + ingest |
| `channel-manager/inbound/index.js` | `buildChannelInbound()` DI factory |
| `test/channelInboundWebhook.test.js` | 9 tests |
| `docs/QYRVIA_PHASE24_STEP_B8B4_INBOUND_WEBHOOK_REPORT.md` | this report |

## 3. Files modified
| File | Change |
|---|---|
| `channel-manager/api/channel.routes.js` | Gated `POST /webhook/:channel` (default off ⇒ not mounted) |
| `config/env.js` | Added `CHANNEL_WEBHOOK_ENABLED` (default `false`) |
| `index.js` | DI: build `channelInbound`; add to `createApp` deps |

No change to: PMS command code (only dispatched via commandBus), worker, queue, outbound sync, credential/mapping
domains, frontend/UI. No new migration (reuses `booking_store` from 0045).

## 4. Validation
| Check | Result |
|---|---|
| Backend suite (before → after) | **543 / 0 / 3 (546) → 552 / 0 / 3 (555)** (+9, zero regressions) |
| Default API unchanged | ✅ route gated off; gating test proves absent when disabled, present when enabled |
| Signature validation | ✅ valid HMAC passes; tampered/invalid/empty-secret fail |
| Idempotent ingestion | ✅ duplicate + lower-rank stale ⇒ no-op, no extra PMS dispatch |
| Monotonicity / exceptions | ✅ advance ⇒ update; cancel-after-CHECKED_IN ⇒ exception, no mutation |
| PMS via commandBus only | ✅ `create`/`update` dispatched with correlation; `pms_reservation_id` linked |
| Failure handling | ✅ command failure ⇒ link-pending, no duplicate on retry |
| Unknown channel / no-secret | ✅ 404 unknown; no-secret + not-required ⇒ ingests |
| Audit safe | ✅ metadata only (no guest name / payload) |

**Test coverage (9):** verifier (valid/tampered) · create + PMS dispatch + link · idempotency
(dup/stale/advance) · cancel-after-presence exception · command-failure link-pending · ingress
signature (200/401/404) · no-secret path · audit safety · route gating (off/on).

## 5. Idempotency & correctness (Step 3 model applied)
- **Dedupe:** `booking_store UNIQUE(tenant, channel, external_ref)` + status-rank monotonicity
  (PENDING<CONFIRMED<CHECKED_IN<CHECKED_OUT; CANCELLED terminal). Equal/lower rank ⇒ no-op.
- **Correlation:** `external_ref` maps any redelivery to the same booking; existing `pms_reservation_id`
  ⇒ `update`, never a duplicate `create`.
- **Exception:** cancel after physical presence is rejected (not silently applied), per Step 3 §5.
- **At-least-once safe:** webhook redelivery + retry are absorbed by the above ⇒ exactly-once effect.

## 6. Risk assessment
| Risk | Level | Mitigation |
|---|:---:|---|
| New public endpoint exposure | **NONE by default** | Route mounted only when `CHANNEL_WEBHOOK_ENABLED=true` + pipeline wired; RBAC `channel.sync.run` |
| Duplicate PMS reservations | LOW | external_ref correlation + monotonicity + link-pending on failure |
| Unsigned/forged webhook | LOW | HMAC verification when a secret is configured; `requireSignature` option to force it |
| PMS write coupling | LOW | commandBus dispatch only; no PMS code change; transactional per command contract |
| Secret/PII leakage | LOW | Verifier pure; audit metadata only; secret resolved via SecretProvider, never logged |
| Migration impact | NONE | Reuses `booking_store`; no new migration |

## 7. Rollback plan
- **Instant:** keep `CHANNEL_WEBHOOK_ENABLED=false` (default) ⇒ route never mounts; pipeline inert.
- **Code:** delete `channel-manager/inbound/*` and `test/channelInboundWebhook.test.js`; revert the
  `channel.routes.js` gated block, the `env.js` flag, and the `index.js` DI lines. Nothing else imports
  the inbound pipeline.

## 8. Constraints honored
✅ No external network · ✅ No OTA credentials · ✅ No PMS code changes (commandBus only) · ✅ No
worker/outbound changes · ✅ No UI/frontend changes · ✅ No Booking Engine / CRM / Revenue / AI work.
API change is additive + default-off within the channel domain. **UI protection rule:** no UI file
touched (N/A).

**STOP after B8-B4.** Awaiting approval for B8-B5 (roll third-party OTAs to production credentials +
real HTTP transport + full bi-directional sync) — the highest-risk stage.
