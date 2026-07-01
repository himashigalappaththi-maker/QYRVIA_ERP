# QYRVIA Phase 24 — B8-B: Real OTA Connectivity Readiness Audit & Implementation Blueprint

**Mode:** AUDIT + BLUEPRINT. **Documentation only — no code, no schema, no commits, no network.**
Determines exactly what is required to turn the canonical adapter framework (B8-A) into real
connectivity for **Booking.com, Agoda, Expedia, Airbnb, QTCN**.

**Evidence base (read live):** `adapters/framework/*` (B8-A), `adapters/{bookingcom,qyrcn,agoda,
expedia,airbnb}/*Adapter.js` (mocks), `core/canonical/types.js` (CHANNELS), persistence
(`migrations/0045/0046`, `persistence/*`), worker (`worker/*`), `services/connectorRegistry.js`
(existing credential/config precedent), `core/eventBus.js` + `event_store`.

---

## 1. OTA Connectivity Gap Analysis

Channels (`canonical/types.js`): `BOOKING_COM, AGODA, EXPEDIA, AIRBNB, QTCN` (QTCN = QYRVIA's own
internal, low-commission distribution engine — behaves like an OTA, **no third party**).

| Capability | Current (mock) | Missing for real connectivity |
|---|---|---|
| **Outbound transport** | adapters `logger.debug(...)` instead of HTTP (e.g. `BookingComAdapter.pushRates`) | real REST/XML client per OTA; request signing; timeouts/retries at transport |
| **Authentication** | `AuthStrategy` abstract + `NoopAuthStrategy` (ref=null) | concrete strategies per OTA (API-key / OAuth2 client-credentials / signed-HMAC); `getAuthHeaders()` resolution |
| **Credential management** | none live; `channel_mapping_store.credentials_ref` column exists but unused; `connectorRegistry` stores `config_json` (plaintext, audited) | secret store (encrypted at rest), `credentials_ref → secret` resolution at the edge, per property |
| **Webhook / inbound** | **none** — pull-only (`pullBookings()`), no `/channel/webhook` route; `handleWebhook()` contract exists but unrouted | inbound endpoint, signature validation, idempotent ingestion, OTA→PMS reservation creation |
| **Rate sync** | `pushRateUpdate` mock no-op | real rate push payload mapping per OTA; delta via `sync_state_store.last_hash` |
| **Inventory sync** | `pushAvailability` mock no-op | availability source from PMS, OTA availability payload, restriction (stop-sell/min-max LOS) support |
| **Reservation ingestion** | `normalizeBooking` works on canned raw; never reaches PMS | webhook/pull → `booking_store` → `commandBus('pms.reservation.create')` (the §4 bridge) |
| **Mapping** | `channel_mapping_store` schema only (`ota_room_id`, `ota_rate_plan_id`) — unpopulated | mapping management + population, versioning, audit (§3) |

**Summary:** the *architecture* is in place (canonical contract, queue, worker, persistence, events);
**every edge that touches a real OTA or PMS is mock or absent.** No blocker — net-new builds.

---

## 2. Credential Architecture

### 2.1 Property-level credentials & multi-property isolation
- Credentials are scoped **(tenant_id, property_id, channel)** — the same key as `channel_mapping_store`
  and RLS (`current_setting('app.tenant_id')`). Each property has independent OTA accounts.
- Isolation is enforced exactly like every other store: per-tenant RLS + property-scoped keys; no
  cross-property credential read is possible under `withTenant`.

### 2.2 Credential reference model (no secrets in the core)
```
channel_mapping_store.credentials_ref  --->  channel_credential_store (new, encrypted)
                                              resolved ONLY at the adapter edge by AuthStrategy
```
- The core/services/worker carry only the opaque `credentials_ref` (already in the schema + B8-A
  `AuthStrategy`). The secret value never enters core memory, logs, or events.

### 2.3 Secret storage design (recommended)
- New logical store `channel_credential_store`: `{ id, tenant_id, property_id, channel,
  credentials_ref (uniq), secret_ciphertext, key_version, rotated_at, created_at }` — **encrypted at
  rest** (envelope encryption; KMS/app key), RLS per tenant, `REVOKE SELECT` from app role except a
  dedicated resolver path.
- **Do NOT** reuse `connectorRegistry.config_json` for secrets (plaintext). Keep `connectorRegistry`
  for non-secret config; route secrets through the encrypted store.
- A `SecretProvider` interface (pluggable: app-encryption now, external vault later) is what
  `AuthStrategy.getAuthHeaders()` calls to resolve `credentials_ref → live secret`.

### 2.4 Rotation strategy
- `key_version` + `rotated_at` support zero-downtime rotation: write new ciphertext under a new
  `credentials_ref`/version, flip the mapping's `credentials_ref`, retire the old after a grace window.
- Rotation is audited via `event_store` (`channel.credential_rotated`), never logging the secret.

---

## 3. OTA Mapping Architecture

### 3.1 Entity mappings (substrate already exists in `channel_mapping_store`)
| PMS side | OTA side | Column |
|---|---|---|
| `room_types.id` | OTA room type | `ota_room_id` |
| `rate_plans.id` | OTA rate plan | `ota_rate_plan_id` |
| property (tenant_id, property_id) | OTA property/hotel id | (add) `ota_property_id` |

### 3.2 Property mapping requirements
- A property must be fully mapped (every sellable room_type + rate_plan ↔ OTA ids) and `enabled=true`
  before outbound sync engages; unmapped resources are **skipped** (outbound) / **DLQ'd** (inbound),
  never dropped (Step 3 §5).

### 3.3 Versioning strategy
- Mapping rows carry `updated_at`; add a `mapping_version` and an append-only
  `channel_mapping_history` (logical) so a booking can be reconciled against the mapping that was live
  at ingest time (important for disputes / late webhooks).

### 3.4 Audit requirements
- Every mapping create/change/disable emits a durable `event_store` event
  (`channel.mapping_created|updated|disabled`) via the shared bus — consistent with all other domain
  mutations; queryable for compliance.

---

## 4. Webhook Architecture (inbound OTA → PMS)

### 4.1 Events
`booking.created`, `booking.modified`, `booking.cancelled` (and `no_show`) arrive as OTA webhooks →
`adapter.handleWebhook(req)` → `{ verified, events: CanonicalBooking[] }`.

### 4.2 Ingress (new, additive — no existing route changes here, designed for B8-B4)
```
POST /api/channel/webhook/:channel   (new, RBAC: channel.sync.run or a webhook scope)
  -> resolve adapter (canonical registry)
  -> adapter.handleWebhook(req): verify signature -> normalizeBooking[]
  -> channelInboundService: booking_store upsert (idempotent) ->
       commandBus.dispatch('pms.reservation.create'|'update'|cancel)
```

### 4.3 Signature validation
- Per-OTA HMAC/signature verified **inside the adapter** using the resolved secret (via AuthStrategy).
  A short replay-nonce window rejects replays before canonicalization (Step 3 §2.2).

### 4.4 Retry handling
- OTA redeliveries are absorbed by idempotency (below); failed inbound dispatch → retry via the
  durable queue/worker → DLQ on exhaustion (B6 already provides this).

### 4.5 Idempotency strategy
- `booking_store UNIQUE(tenant_id, channel, external_ref)` + status-rank monotonicity (Step 3 §1.3):
  a redelivered `external_ref+status` is a no-op; a new status advances state; correlation maps any
  retry to **update**, never duplicate-create.

---

## 5. Synchronization Architecture (outbound PMS → OTA)

| Concern | Design (reuses existing pieces) |
|---|---|
| Availability updates | PMS availability → `channelSubscriber` (B5) enqueues `pushAvailability` per mapped channel via `sync_queue_store`; worker (B6) delivers |
| Rate updates | `rate_plan.*` → enqueue `pushRateUpdate`; OTA rate payload mapped in adapter |
| Restriction updates | extend `CanonicalInventory` (stop-sell, min/max LOS already in `hashInv`) → `pushAvailability` carries restrictions |
| Delta detection | `sync_state_store.last_hash` (SyncEngine delta) — unchanged resources skipped |
| Conflict handling | Step 3 model: source-of-truth hierarchy, status-rank, `ConflictResolver`; `source_channel` prevents echo-back |

**Flow:** `PMS event → subscriber → delta check → sync_queue_store → worker → adapter.push* → real OTA`.
Everything left of `adapter.push*` exists today (mock); B8-B replaces the adapter edge with real HTTP.

---

## 6. Readiness Scoring

| Dimension | Score | Basis |
|---|:---:|---|
| **Authentication readiness** | **25%** | Abstract `AuthStrategy` + Noop only; no concrete strategies, no secret resolution |
| **Mapping readiness** | **50%** | `channel_mapping_store` schema (room/rate/credentials_ref) exists; unpopulated, no versioning/history/management API |
| **Sync readiness** | **60%** | Queue + worker + delta `sync_state` + canonical push methods all present; all mock, no HTTP, no restrictions payload |
| **Webhook readiness** | **20%** | `handleWebhook` contract exists; no ingress route, no signature validation, pull-only today |
| **Persistence readiness** | **80%** | 5 stores designed (0045/0046) + memory/dual/db + worker; needs db activation + real wiring |
| **Production OTA readiness** | **35%** | Strong architecture, mock integration; weighted blend of the above |

> Reading: QYRVIA is **architecturally ready, integration-pending**. The skeleton is production-shaped;
> the deltas are concrete, bounded builds (credentials, mapping mgmt, real transport, webhook ingress).

---

## 7. Implementation Roadmap (B8-B1 → B8-B5, lowest → highest risk)

| Stage | Scope | Risk | Why this order |
|---|---|:---:|---|
| **B8-B1** | Secret storage + `credentials_ref` resolution + concrete `AuthStrategy` impls (API-key/OAuth2/HMAC) — **internal, mock-resolved, no live calls** | **LOW** | Pure internal data + interfaces; fully unit-testable; unblocks everything |
| **B8-B2** | Mapping management: populate `channel_mapping_store` (room/rate/property), versioning + `mapping_history` + audit events — **internal data only** | LOW-MED | No external calls; prerequisite for any real sync |
| **B8-B3** | **QTCN real connectivity first** (internal engine, no third party), then Booking.com sandbox: real outbound `pushAvailability/pushRateUpdate` over HTTP behind a per-channel flag; delta via `sync_state` | MED | QTCN has no external dependency → safest first real edge; one OTA in sandbox proves the transport |
| **B8-B4** | Inbound webhook ingress (`POST /api/channel/webhook/:channel`) + signature validation + idempotent `booking_store` → `commandBus('pms.reservation.create')` | MED-HIGH | Highest coordination (PMS write path); guarded by idempotency + DLQ |
| **B8-B5** | Roll Agoda/Expedia/Airbnb to production credentials; full bi-directional sync + restrictions + conflict + DLQ ops dashboards | HIGH | Multi-OTA production; done last when transport + webhook + mapping are proven |

Each stage is independently shippable behind per-channel `enabled` flags and `health()`-gating;
nothing goes live until its predecessor is proven.

---

## 8. Future-module compatibility (verified non-blocking)

| Module | Compatibility |
|---|---|
| **QYRVIA Booking Engine** | A first-class internal channel (like QTCN); reuses `channel_mapping_store` + `sync_queue_store` + `booking_store`; `source_channel` prevents echo-back to OTAs |
| **AI WhatsApp Booking Agent** | Creates reservations through the **same** `pms.reservation.create` command → `reservation.created` → identical subscriber→queue path; no special-casing; conversational metadata rides JSONB payloads |
| **CRM** | Read-only consumer of `event_store` + `booking_store` (guest/booking history); credential store is isolated from CRM |
| **Revenue Forecasting** | Already a read-only subscriber (`revenueSubscriber`); `booking_store`/`sync_state_store` are extra read projections; OTA bookings enrich demand signal with no coupling |
| **Multi-Property Architecture** | Every credential/mapping/queue/state row is `(tenant_id, property_id)`-scoped with RLS — the design is multi-property-native, not retrofitted |

---

## 9. UI protection rule (future — not now)
When UI modernization begins, audit and remove all legacy footprints — V24/V30 remnants, GreenKey
branding, deprecated menus, legacy routes, obsolete assets, duplicate navigation — so QYRVIA presents
a single unified branded interface. **No UI was touched in this audit.**

## 10. Constraints honored
✅ Audit only · ✅ Read live code only · ✅ No UI / frontend / PMS / schema / API changes · ✅ No OTA
credentials / network calls · ✅ No Booking Engine / WhatsApp / CRM / Revenue work · ✅ No code, no
commits. **Documentation only.**
