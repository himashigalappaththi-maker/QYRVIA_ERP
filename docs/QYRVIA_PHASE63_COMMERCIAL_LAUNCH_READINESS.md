# QYRVIA Phase 63 — Commercial Launch Readiness

**Status:** IN PROGRESS  
**Target:** Controlled commercial launch in August 2026  
**Decision rule:** QYRVIA may be sold only with the capability labels and launch
gates in this document. External OTA connectivity remains disabled or explicitly
labelled pilot/beta until each provider is certified with real credentials.

## 1. Commercial launch boundary

### General availability candidate

- Multi-tenant ERP and PMS core
- Direct Booking Engine
- ARI pricing and availability
- QYRVIA Connect in-process distribution
- Finance and operational modules that pass the Phase 63 regression gate

### Controlled pilot only

- Booking.com, Expedia, Agoda, Airbnb, MakeMyTrip, Google Hotel/Travel, and
  TripAdvisor connectivity
- Live payment, email, WhatsApp, and other credential-dependent transports

An external integration must not be represented as generally available merely
because its adapter, codec, mock transport, or unit tests pass.

## 2. Non-negotiable launch gates

| Gate | Required evidence | Status |
|---|---|---|
| G1 — Scope freeze | Published GA/pilot/unsupported capability matrix | IN PROGRESS |
| G2 — Automated regression | Unit suite completes with zero failures | PENDING |
| G3 — Real database | Guarded PostgreSQL suite passes with RLS isolation | PENDING |
| G4 — Booking correctness | Full-stay, concurrency, overbooking, multi-room, cancellation, and idempotency pass | PENDING |
| G5 — Payment correctness | Initiate/confirm/fail/retry/refund paths reconcile without duplicate charge or booking | PENDING |
| G6 — Channel safety | Kill switch, credential isolation, webhook verification, deduplication, retry, DLQ, replay, and reconciliation pass | PENDING |
| G7 — External certification | Per-OTA sandbox/live evidence and provider approval | BLOCKED-EXTERNAL |
| G8 — Security | Auth, RBAC, tenant isolation, secret handling, rate limits, and production configuration pass | PENDING |
| G9 — Reliability | Load, soak, restart recovery, queue recovery, backup, and restore drill pass | PENDING |
| G10 — Operations | Monitoring, alerts, runbooks, incident ownership, support escalation, and rollback are ready | PENDING |
| G11 — Pilot acceptance | At least one representative property completes signed operational acceptance | PENDING |
| G12 — Go/no-go | Evidence reviewed; unresolved risks explicitly accepted by an authorized owner | PENDING |

Any failure in G3–G6 or G8 is a launch blocker for the affected capability.
G7 blocks only the affected external channel when the channel is disabled by
default and excluded from the commercial promise.

## 3. Booking Engine acceptance criteria

- Availability fails closed when inventory cannot be established.
- Availability is evaluated across every night of the stay.
- Concurrent requests cannot sell beyond the configured inventory ceiling.
- Idempotency prevents duplicate reservations and duplicate payment initiation.
- Confirmation rechecks inventory and preserves a consistent booking/payment state.
- Cancellation releases inventory exactly once.
- Multi-room bookings reserve all requested inventory atomically or fail without
  partial reservation.
- Prices, taxes, currency, restrictions, and totals remain stable from quote
  through confirmation unless an explicit reprice is accepted.
- Every state transition is tenant/property scoped and auditable.

## 4. Channel Manager acceptance criteria

- External channels are disabled and non-live by default.
- Credentials are encrypted, tenant scoped, redacted from logs, and never returned
  by read APIs.
- Inbound webhooks verify authenticity before processing.
- Duplicate and out-of-order events cannot corrupt reservation state.
- Outbound work is durable, idempotent, retryable, observable, and dead-lettered
  after bounded attempts.
- Replay cannot bypass ownership, generation, or idempotency guards.
- Reconciliation detects booking, inventory, and rate drift and provides a safe
  remediation path.
- Per-channel kill switches stop new dispatch without losing queued work.
- Provider-specific sandbox and certification evidence exists before a channel is
  marked live.

## 5. Four-week execution sequence

### Week 1 — Evidence and blocker closure

1. Freeze the commercial capability matrix.
2. Complete unit and guarded database baselines.
3. Fix all Booking Engine and Channel Manager correctness failures.
4. Provision a production-like staging environment.

### Week 2 — Reliability and security

1. Run concurrency, load, soak, restart, and queue-recovery tests.
2. Complete backup/restore and rollback drills.
3. Validate production secrets, RBAC, RLS, rate limits, logging, and alerting.
4. Close launch-blocking security findings.

### Week 3 — Pilot

1. Deploy to one controlled pilot property with approved change control.
2. Run real operational workflows and reconcile daily.
3. Keep external OTAs disabled unless their individual certification gate passes.
4. Capture defects, recovery evidence, and operator acceptance.

### Week 4 — Launch decision

1. Close pilot defects and rerun all affected gates.
2. Finalize onboarding, support, incident, backup, and rollback runbooks.
3. Publish the supported capability matrix and known limitations.
4. Hold the authorized go/no-go review.

## 6. Immediate work order

1. Finish a zero-failure launch-specific unit baseline.
2. Run the guarded real-PostgreSQL suite.
3. Add or repair any missing atomic multi-room and failure-recovery coverage.
4. Run production preflight in a production-like environment.
5. Prepare per-OTA certification work orders; do not enable an external channel
   without explicit authorization and credentials.

## 7. Approval boundaries

This phase definition does not authorize:

- database writes outside disposable/local test databases;
- use of production or third-party credentials;
- enabling external OTA transports;
- Git staging, commit, or push;
- deployment to any environment.

Those actions require explicit authorization and must be executed through their
respective approval gates.

---

# 8. Phase 63 Execution Board

Built from a four-lane parallel investigation (PMS, Booking Engine + payments,
Channel Manager, production infrastructure), then executed. Every item below
carries file-level evidence. Items marked **FIXED** were implemented and are
covered by an automated test in this repository; items marked **OPEN** were
verified to exist and are NOT fixed.

Severity: **P0** prevents any real booking or hotel operation - **P1** unsafe for
a controlled hotel pilot - **P2** required before public beta - **P3** post-beta.

## 8.1 P0 - blocks any real booking or hotel operation

### P0-1 - Domain event stream silently truncated to one event per aggregate - FIXED
- **Subsystem:** core / audit
- **Defect:** `insertDomainEvent` wrote a hard-coded `event_version = 1`, while
  `0014_aggregate_snapshots.sql:29` declares
  `UNIQUE INDEX ux_event_store_version (tenant_id, aggregate_type, aggregate_id, event_version)`.
  The second and every later domain event for an aggregate failed with 23505 and
  `commandBus.dispatch` swallowed it while still returning `ok:true`.
- **Evidence:** reproduced live - the guarded DB suite emitted
  `duplicate key value violates unique constraint "ux_event_store_version"` from
  `finance_flows.db.test.js` while the test still passed. A reservation's whole
  chain (created -> checked_in -> folio.posted -> payment.allocated -> checked_out)
  is one aggregate stream, so only the first event was ever durable.
- **Files:** `server/src/index.js` (dbFacade), `server/src/core/eventStoreWriter.js` (new),
  `server/test/db/_dbHarness.js`
- **Action:** compute `event_version = COALESCE(MAX(...),0)+1` inside the INSERT
  with `ON CONFLICT (...) DO NOTHING` plus bounded retry, so a version race is
  resolved rather than lost and a replayed `event_id` still raises.
- **Test:** `server/test/eventStoreWriter.test.js` (8), `server/test/db/event_store_versioning.db.test.js` (4, real PostgreSQL incl. 8-way concurrency)
- **Status:** FIXED

### P0-2 - Server boots and reports healthy against a stale schema - FIXED
- **Subsystem:** production infrastructure
- **Defect:** `server/src/index.js` had no migration-state logic. `/health/ready`
  only pings the connection, so a container missing migrations answered
  `{db:"ok"}`, was marked healthy, and served financial traffic on an outdated
  schema. The only drift check (`server/scripts/prod-preflight.js:208-217`) was
  wired into nothing.
- **Files:** `server/src/db/migrationPreflight.js` (new), `server/src/index.js`
- **Action:** compare `schema_migrations` against the shipped chain before the
  listener opens; `process.exit(2)` in production on pending versions or on a
  schema ahead of the build; warn only outside production.
- **Test:** `server/test/migrationPreflight.test.js` (10)
- **Status:** FIXED

### P0-3 - A booking could be confirmed with no payment evidence - FIXED
- **Subsystem:** Booking Engine / payments
- **Defect:** every gate in `confirmBooking` was written `if (paymentState && ...)`,
  so a NULL state row skipped the status check AND the hold-expiry check, and
  `verifyResult` defaulted to `{ok:true,status:'paid'}`. `server/src/index.js`
  builds the provider, state store and attempt log in one `try/catch`, so a
  single misconfiguration dropped all three and every confirm sailed through.
- **Files:** `server/src/booking-engine/bookingService.js`
- **Action:** fail closed - `requirePayment` (default true) demands a wired
  store AND provider, a `paymentId`, an existing state row and a bounded hold;
  the verification default is now `unverified`, not `paid`.
- **Test:** `server/test/phase63_booking_payment_failclosed.test.js` (P0-3 group, 7)
- **Status:** FIXED

### P0-4 - Booking Engine could not create a reservation through the real command bus - FIXED
- **Subsystem:** Booking Engine / PMS contract
- **Defect:** `mapInput` never emitted `primary_adult_guest_id`, which
  `pms.reservation.create` requires via `_strReq` - so every booking dispatched
  to the real bus returned `validation_failed`. Invisible to tests because all
  booking unit tests use a fake command bus. `rooms_count`, `rate_plan_id`,
  `child_policy_id` and `child_ages` were dropped by the same mapping, which
  also disabled the occupancy/child-capacity check entirely.
- **Files:** `server/src/booking-engine/bookingService.js`, `server/src/commands/pms/index.js`
- **Test:** `server/test/phase63_booking_payment_failclosed.test.js` (P0-4 group, 2)
- **Status:** FIXED

### P0-5 - Multi-room requests were satisfied by a single room - FIXED
- **Subsystem:** Booking Engine availability
- **Defect:** `availabilityEngine.check` returned `available: n > 0` regardless
  of rooms requested; combined with the dropped `rooms_count` a 3-room request
  was accepted against 1 room and booked as 1.
- **Files:** `server/src/booking-engine/availabilityEngine.js`
- **Action:** compare against demand; absent/invalid `rooms_count` resolves to 1, never 0.
- **Test:** `server/test/phase63_booking_payment_failclosed.test.js` (P0-5 group, 4)
- **Status:** FIXED

### P0-6 - Payment holds consumed no inventory (overbooking window) - FIXED
- **Subsystem:** Booking Engine / PMS availability
- **Defect:** `initiateBooking` created the reservation as `INQUIRY`, and
  `HOLD_STATUSES` counted only `CONFIRMED`/`OPTION`. `PENDING_PAYMENT` existed in
  the enum (`0066_booking_payment_state.sql:23`) but no code read or wrote it.
  N concurrent guests could each hold the same last room for the whole 15-minute
  payment window and all be told it was available.
- **Files:** `server/src/booking-engine/bookingService.js`,
  `server/src/commands/pms/index.js`, `server/src/services/pms/availability.js`
- **Action:** create in `PENDING_PAYMENT` via a closed `initial_status` allow-list;
  count it as a hold; permit `PENDING_PAYMENT -> CONFIRMED` and `-> CANCELLED`.
- **Test:** `server/test/phase63_pms_hardening.test.js` (P0-6 group, 2), `phase63_booking_payment_failclosed.test.js` (P0-6, 1)
- **Status:** FIXED

### P0-7 - Out-of-order and blocked rooms were sellable - FIXED
- **Subsystem:** PMS availability
- **Defect:** the room loops filtered on `active` only, so `OUT_OF_ORDER`,
  `OUT_OF_SERVICE` and `BLOCKED` rooms counted towards sellable `total`.
- **Files:** `server/src/services/pms/availability.js`
- **Test:** `server/test/phase63_pms_hardening.test.js` (P0-7 group, 3)
- **Status:** FIXED

### P0-8 - Guest charged for a reservation the sweep had just cancelled - FIXED
- **Subsystem:** payments / hold expiry
- **Defect:** `paymentStateStore.upsert` is an unconditional
  `ON CONFLICT DO UPDATE`, not a compare-and-set. `confirmBooking` read
  `pending`, the hold-expiry sweep flipped the row to `failed` and cancelled the
  PMS reservation, and confirm then verified (captured) the payment.
- **Files:** `server/src/payment/paymentStateStore.js`,
  `server/src/payment/paymentStateStoreDb.js`, `server/src/payment/holdExpirySweep.js`,
  `server/src/booking-engine/bookingService.js`
- **Action:** `transitionPending()` - an atomic `UPDATE ... WHERE payment_status='pending_payment'`
  used by both confirm and the sweep, so exactly one wins. A PMS confirm failure
  after capture is now reported as `payment_captured: true, requires_reconciliation: true`
  instead of silently returning a bare error.
- **Test:** `server/test/phase63_booking_payment_failclosed.test.js` (P0-8 group, 4)
- **Status:** FIXED

### P0-9 - Business-date lookup failed OPEN, defeating the night-audit lock - FIXED
- **Subsystem:** PMS accounting control
- **Defect:** `businessDateMiddleware` treated a NULL repo result as "new
  property" and defaulted `businessDate = today` with `businessDateLocked = false`.
  NULL also means "property not visible" (RLS-blocked, wrong tenant, deleted), so
  a blocked lookup produced a request that believed accounting was unlocked and
  stamped folio lines with a fabricated business date.
- **Files:** `server/src/middleware/businessDate.js`, `server/test/_fixtures.js`
- **Action:** a missing row is now `409 property_business_date_unresolved`; a row
  with a null date still defaults to today but carries the REAL lock flag.
- **Test:** `server/test/businessDate.test.js` (2 new). The fixture was corrected -
  it returned NULL for any unseeded property, conflating two states that
  PostgreSQL never conflates, and that is what hid the bug.
- **Status:** FIXED

### P0-10 - A duplicate night audit froze the property's accounting forever - FIXED
- **Subsystem:** night audit
- **Defect:** the business-date lock was taken BEFORE the `try` block, and
  `insertRun` sits between them. `ux_night_audit_property_busdate` is UNIQUE on
  `(property_id, business_date)`, so a double-click, a scheduler retry, or a
  retry after a FAILED run threw with the lock set and nothing to release it. No
  route or command can unlock a property, so every accounting-sensitive command
  was rejected for that property permanently.
- **Files:** `server/src/services/pms/nightAudit.js`
- **Test:** `server/test/phase63_pms_hardening.test.js` (P0-10 group, 3)
- **Status:** FIXED

### P0-11 - PMS repositories never bind `app.tenant_id` under FORCE RLS - **OPEN**
- **Subsystem:** PMS persistence / tenant isolation
- **Defect:** `server/src/db/repos.js` contains 221 bare `pool.query` calls.
  `_withTenantForPool` (which issues `set_config('app.tenant_id', ...)`) exists but
  is used at exactly two sites (`repos.js:2366, 2382`, user_roles). Every PMS,
  folio, housekeeping and night-audit repo method queries the pool directly,
  while `reservations` (`0019_pms_reservations.sql:63-67`), folios and
  housekeeping (`0023_arch_folio_housekeeping.sql`), payment allocations
  (`0037`), night-audit runs (`0025`) and `properties` (`0004`) all carry
  `ENABLE + FORCE ROW LEVEL SECURITY` with policies keyed on
  `current_setting('app.tenant_id', true)`.
- **Consequence:** under the non-superuser, non-BYPASSRLS role this project's own
  guard mandates (`server/test/db/_rlsGuard.js`), the entire
  reservation -> check-in -> folio -> payment -> night-audit -> check-out chain
  returns zero rows or fails at insert. If it currently works anywhere, the app
  role holds superuser/BYPASSRLS - meaning tenant isolation is not enforced at
  all. The repo file itself flags the pattern at `repos.js:242`.
- **Why not fixed here:** correcting 221 call sites (or introducing a
  request-scoped tenant-bound pool) is an architectural change that cannot be
  validated safely inside one accelerated session. It also interacts with
  P1-5/P1-6 below (multi-statement atomicity), which must be designed together.
- **Required action (Phase 64, first item):** route every tenant-scoped repo
  method through a tenant-bound client; then add
  `server/test/db/pms_stay_lifecycle.db.test.js` running the full chain against
  real PostgreSQL as a non-superuser role.
- **Status:** OPEN - highest-risk launch blocker in the system.

### P0-12 - The outbound PMS -> OTA path is not connected end to end - **OPEN**
- **Subsystem:** Channel Manager outbound
- **Defect:** four independent breaks, each individually fatal:
  1. `services/channelEventRouter.js:22` stamps `channel: 'channel-manager'` - a
     literal, not an OTA code - so `realProcessor.js:59` would reject every job
     as `no_provider_for_channel`; there is no per-OTA fan-out.
  2. `services/channelSubscriber.js:85-92` never sets `tenant_id`, so
     `realProcessor.js:39` rejects with `tenant_required` and the DLQ records
     `tenant_id: 'unknown'`.
  3. `worker/realProcessor.js` is instantiated by no production code; only
     `mockProcessor` is ever wired (`server/src/index.js`).
  4. `channelOutboundSync.service` (`pushRate`/`pushAvailability`/`pushReservation`)
     is called from no production code, and `server/src/ari/` has zero coupling
     to the channel manager - there is no ARI -> outbound ARI push at all.
- **Partially fixed here:** the queue-identity break (P1-4 below) is fixed.
  The four breaks above are not.
- **Consequence:** inventory, rate and reservation changes reach no channel,
  silently - no error, no dead-letter row, no alert. Overbooking follows directly.
- **Status:** OPEN - highest-risk Channel Manager blocker.

### P0-13 - Inbound OTA webhooks are structurally unusable and not byte-verified - **OPEN**
- **Subsystem:** Channel Manager inbound
- **Defect:** (a) `server/src/app.js:70` registers `express.json()` with no
  `verify` callback, so `req.rawBody` is always undefined and
  `inbound/webhookVerifier.js:12` HMACs `JSON.stringify(body)` - a signature over
  a re-serialised object, not the bytes the OTA signed. (b) The webhook route
  (`channel-manager/api/channel.routes.js:77`) sits behind `protectedChain` and
  `requirePermission('channel.sync.run')`, so a real OTA cannot authenticate at
  all. (c) No timestamp, nonce or replay window - a captured signed body replays
  forever. (d) `ota/dedupKey.js` and the `ota_inbound_event_dedup` table are
  built and tested but never called from the inbound path.
- **Status:** OPEN. Mitigated only by `CHANNEL_WEBHOOK_ENABLED=false` by default.

## 8.2 P1 - unsafe for a controlled hotel pilot

### P1-1 - Event-persistence failures were silent - FIXED
`commandBus` logged and continued with `ok:true`. Now a stable
`event_persistence_failed` code, an injected failure hook wired to metrics and a
security event at boot, and a non-enumerable `eventPersistenceFailures` marker
on the outcome (response shape unchanged).
Files: `server/src/core/commandBus.js`, `server/src/index.js`.
Test: `server/test/commandBus_event_persistence.test.js` (6). **Status: FIXED**

### P1-2 - No executable smoke test - FIXED
`deployment/SMOKE_TEST_CHECKLIST.md` was a human checkbox list. Added
`server/scripts/smoke-test.js` (`npm run smoke`): read-only GET probes for
liveness, readiness, the `/api` twins, a closed auth gate (a 200 there is a hard
failure), 404 handling and metrics. Local-only unless `--allow-remote` is typed
explicitly; exit 2 on an unsafe target.
Test: `server/test/smokeTestScript.test.js` (8). **Status: FIXED**

### P1-3 - The production env gate was silently skippable - FIXED
`validateProductionEnv` runs only when `NODE_ENV === 'production'`, and NODE_ENV
defaults to `development`. A deploy that forgot to set it booted with
`PAYMENT_PROVIDER=mock`, a localhost `APP_BASE_URL`, a 32-char JWT secret and no
encryption-key check - with no signal. Now: an unset NODE_ENV always warns, and
an unvalidated boot against a NON-LOCAL database is refused (loopback
development, CI and the DB test runner are untouched; the escape hatch
`QYRVIA_ALLOW_UNVALIDATED_REMOTE_DB=true` is explicit and still warns).
Files: `server/src/config/envValidation.js`, `server/src/config/env.js`.
Test: `server/test/envUnvalidatedBoot.test.js` (9). **Status: FIXED**

### P1-4 - The channel worker polled a queue nothing writes to - FIXED
The worker was constructed with a brand-new `buildLeaseQueue()` while the event
spine enqueues into `channelPersistence.queue`; it processed zero jobs, silently.
Now bound to the spine's queue, with a loud warning if it has to fall back.
File: `server/src/index.js`. **Status: FIXED** (does not resolve P0-12).

### P1-5 - Check-in and check-out are non-atomic - **OPEN**
`server/src/commands/pms/checkinFolio.js:64-80` (check-in) and `:125-142`
(check-out) chain 3-4 independent statements with no `BEGIN`/`COMMIT`
(`grep BEGIN server/src/commands` returns nothing). A failure mid-chain leaves
the reservation CHECKED_IN, the room OCCUPIED and no folio - and the status
guard makes retry impossible (`invalid_transition`). Check-out fails the same
way, leaving the folio OPEN with no housekeeping task. **Status: OPEN**

### P1-6 - Folio line write and balance rollup are unwrapped - **OPEN**
`server/src/db/repos.js:1691-1714`. A rollup failure leaves the line posted and
`folios.balance` stale - and folio balance is the sole gate for both check-out
and folio close. **Status: OPEN**

### P1-7 - No property scoping on the PMS write chain - **OPEN**
`checkinFolio.js:44, 108, 182, 227, 262` and `queries/pms/index.js:261-269`
resolve by tenant only and never compare `property_id` with `ctx.propertyId`. A
user scoped to property A can check out, post charges to, and close a folio in
property B of the same tenant. `pms.folio.list` DOES require `ctx.propertyId`
(`:254-257`), which shows the intended contract. **Status: OPEN**

### P1-8 - Payment allocation leaves partial financial state - **OPEN**
`commands/pms/paymentAllocation.js:30-51` commits allocation rows first and posts
to the ledger afterwards, returning `ledger_post_failed` with the allocations
already persisted; inside the service each insert is its own statement in a loop.
**Status: OPEN**

### P1-9 - OTA modifications are silently dropped - **OPEN**
`inbound/channelInboundService.js:79` treats an equal-rank status as a duplicate,
so a CONFIRMED -> CONFIRMED modification (date, occupancy or rate change) is
discarded as `deduped`. There is no payload hash and no vendor sequence number.
`server/test/channelInboundWebhook.test.js` currently asserts this behaviour.
**Status: OPEN**

### P1-10 - Reconciliation does not detect drift - **OPEN**
`channel-manager/api/channel.controller.js:382-383` takes BOTH the local and the
remote snapshot from the request body. Nothing fetches OTA-side state;
`ota/reconciliation.js` is a pure diff with no puller. Additionally
`sync/channelSyncService.js:51-54` advances `last_hash` even when
`ack.ok === false`, so a failed push poisons the delta cache and the drift is
never re-pushed. **Status: OPEN**

### P1-11 - The channel kill switch fails OPEN - **OPEN**
`inbound/channelInboundService.js:63` does `registry.get(...).catch(() => null)`
then `if (reg && !reg.enabled)`: an unreachable registry lets ingest proceed.
`server/test/channel_kill_switch.test.js` asserts this. Queued jobs for a killed
channel also still dispatch - neither the worker nor `realProcessor` consults the
registry. **Status: OPEN**

### P1-12 - No refund path and no payment callback - **OPEN**
`refund()` exists only on the mock provider and has zero callers; there is no
payment webhook route anywhere, therefore no callback idempotency key or table.
`refunded_at` / `'refunded'` exist in migration 0066 and are never written.
`buildPaymentProvider` supports only `'mock'`, whose `verify()` returns `paid`
for any id. **Status: OPEN**

### P1-13 - Amendments bypass availability and inventory - **OPEN**
`bookingService.updateBooking` never calls availability, the validator, or the
inventory adjuster; dates can be moved into a sold-out period and ARI `sold` is
never rebalanced. **Status: OPEN**

### P1-14 - No backup or restore procedure - PARTIALLY FIXED
`ROLLBACK_PLAN.md` deferred to "restore from backup" with no procedure. Added
`deployment/BACKUP_RESTORE.md`: what to protect (including the encryption keys
that are NOT in the database), targets, dump/verify commands, a restore sequence
that re-applies the role/RLS bootstrap and MANDATES `npm run db:preflight`
before the restored database is usable, the data-loss-window reconciliation duty,
and a drill checklist. **Gate G9 stays PENDING until a drill is actually run and
logged in section 8 of that file.** **Status: PARTIALLY FIXED (documented, undrilled)**

## 8.3 P2 - required before public beta

- **P2-1** No public/unauthenticated booking surface exists. `/booking` is mounted
  behind `protectedChain` and `requirePermission('pms.reservation.*')`
  (`routes/api.js:75`, `booking.routes.js:37-48`). A guest-facing funnel is not
  mounted anywhere. **OPEN**
- **P2-2** Tax is a hard-coded 15% (`pricingEngine.js:11`); no tenant/property tax
  configuration is read and the booking quote has no service-charge line. **OPEN**
- **P2-3** MAKEMYTRIP, GOOGLE and TRIPADVISOR are absent from the live registry
  (`sync/index.js:33-38`) despite having adapters, codecs and registry rows -
  inbound returns `unknown_channel`. AGODA / EXPEDIA / AIRBNB adapters are stubs.
  **OPEN**
- **P2-4** QYRVIA_CONNECT is canonically named but implemented as an in-process
  loopback (`transport/transport.js:16-30` pushes to a discarded array), has no
  codec in `ota/providers/index.js`, and its commission disagrees between
  `QTCNAdapter.js:20` (15) and `registry/defaultChannels.js:23` (0). A separate
  legacy lowercase `qytn` adapter is still discovered and asserted by
  `server/test/ota_scale.test.js:15,21`. **OPEN - conflation confirmed**
- **P2-5** No outbound idempotency key; `ota/transport.js` retries up to 4 times,
  so a timeout can produce duplicate reservation acks. **OPEN**
- **P2-6** No arrival-date eligibility on check-in - any CONFIRMED reservation can
  be checked in arbitrarily far from its arrival date. **OPEN**
- **P2-7** `completeTask` never returns the room to VACANT_CLEAN/INSPECTED, and
  `pms.room.status.change` has no transition table, so room status can desync
  permanently. **OPEN**
- **P2-8** HTTP rate limiters are untestable by construction - both
  `routes/auth.js:52` and `booking.routes.js:28` `skip` on `NODE_ENV==='test'` -
  and use in-process memory, so they are ineffective across instances. **OPEN**
- **P2-9** Reservation `idempotency_key` is stored but never honoured; a duplicate
  surfaces as `validation_failed` with a raw PostgreSQL message instead of
  replaying the original reservation. **OPEN**
- **P2-10** Five whole engine trees (`server/src/pms/**`, `reservation/**`,
  `billing/**`, `housekeeping/**`, `nightaudit/**`) are required by nothing
  outside themselves, yet six test files exercise them - those tests cover no
  production code path. Notably `pms_frontdesk.test.js`'s multi-property
  isolation test asserts against the dead engine while the live command has no
  such check (see P1-7). **OPEN - decide: wire or delete**

## 8.4 P3 - post-beta

- **P3-1** Route-level permission denials are logged but not audited
  (`middleware/authorization.js:78-88`).
- **P3-2** Boot registration failures are swallowed by per-block `try/catch`
  across `server/src/index.js`; the routes still mount and return
  `command_not_registered`. There is no readiness signal for a degraded boot.
- **P3-3** `cryptoBox.js:24` accepts an arbitrary passphrase via SHA-256
  derivation with no length or entropy floor.
- **P3-4** `pino` redaction paths are one level deep; a secret nested at
  `credentials.api_key` or `smtp.pass` is not covered.
- **P3-5** Two channel registries with clashing identity conventions coexist
  (deprecated filesystem/lowercase vs canonical uppercase).

## 8.5 Gate status after this session

| Gate | Before | After | Note |
|---|---|---|---|
| G2 - Automated regression | PENDING | **PASS** | 1713 tests, 1695 pass, 0 fail, 18 skipped |
| G3 - Real database | PENDING | **PASS** | 90 tests, 90 pass, 0 fail against local `qyrvia_test` |
| G4 - Booking correctness | PENDING | **PARTIAL** | P0-3/4/5/6/8 fixed; no real-Postgres concurrency proof (P0-11 blocks it) |
| G5 - Payment correctness | PENDING | **PARTIAL** | fail-closed confirm + CAS hold proven; no refund path, no callback (P1-12) |
| G6 - Channel safety | PENDING | **FAIL** | P0-12, P0-13, P1-9, P1-10, P1-11 all open |
| G8 - Security | PENDING | **FAIL** | P0-11 (RLS not bound on the PMS path) |
| G9 - Reliability | PENDING | **PENDING** | backup/restore documented, drill not run |
| G10 - Operations | PENDING | **PARTIAL** | smoke test + migration preflight added; monitoring/alerting unproven |

**Phase 63 verdict: GATE BLOCK.** Ten P0 defects were fixed and proven; three
(P0-11, P0-12, P0-13) remain open and each independently prevents commercial
operation.
