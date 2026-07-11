'use strict';

/**
 * Process entrypoint. Wires the real PostgreSQL pool to the app, mounts the
 * auth.user.create command into the command bus, starts the HTTP listener,
 * and handles graceful shutdown on SIGTERM / SIGINT.
 */

const env       = require('./config/env');
const logger    = require('./config/logger');
const { createApp } = require('./app');
const db        = require('./db/client');
const { buildRepos } = require('./db/repos');
const commandBus = require('./core/commandBus');
const { makeEvent } = require('./core/event');
// Single shared event-bus handle. Declared here (not lazily lower down) so the
// subscribers wired during boot can reference it without a temporal-dead-zone
// crash.
const eventBusRef = require('./core/eventBus');

// Phase 32 - DB observability. Wrap the shared pool once so every query routed
// through the repos and the audit/event-store writers emits low-cardinality
// metrics + slow-query detection (SQL hash only, never SQL text/params). The
// wrapper is a transparent drop-in; DB_OBSERVABILITY='false' bypasses it.
const { getObservability } = require('./observability');
const { instrumentPool } = require('./observability/instrumentedPool');
const observability = getObservability();
const obsPool = env.DB_OBSERVABILITY === 'false'
  ? db.pool
  : instrumentPool(db.pool, observability);
// Phase 34: expose live DB pool gauges (total/idle/waiting) via the registry.
try { observability.metrics.bindPool(db.pool); } catch (_) { /* telemetry only */ }

/**
 * DB facade for the app. Exposes only what the kernel needs:
 *   - ping()                       : used by /api/health/ready
 *   - insertAuditEvent(event)      : used by eventBus.persistToAudit
 */
const dbFacade = {
  ping: db.ping,
  async insertAuditEvent(ev) {
    await obsPool.query(
      `INSERT INTO audit_events
         (event_id, event_type, aggregate_type, aggregate_id,
          tenant_id, property_id, actor_id, request_id, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ev.event_id, ev.event_type, ev.aggregate_type, ev.aggregate_id,
        ev.tenant_id, ev.property_id, ev.actor_id, ev.request_id,
        ev.payload, ev.occurred_at
      ]
    );
  },
  async insertDomainEvent(ev) {
    // Phase 3 - canonical event store for domain events. version=1 always
    // (per-aggregate versioning lands when PMS phases introduce aggregates).
    await obsPool.query(
      `INSERT INTO event_store
         (id, tenant_id, property_id, aggregate_type, aggregate_id,
          event_type, event_version, payload_json, actor_id, request_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        ev.event_id, ev.tenant_id, ev.property_id, ev.aggregate_type, ev.aggregate_id,
        ev.event_type, 1, ev.payload, ev.actor_id, ev.request_id, ev.occurred_at
      ]
    );
  }
};

const {
  identityRepo, tokensRepo,
  settingsRepo, fileRepo, connectorRepo, schedulerRepo, notificationRepo, webhookRepo,
  aggregateRepo, pmsRepo,
  folioRepo, housekeepingRepo, nightAuditRepo,
  costCenterRepo, revenueMapRepo, ledgerRepo,
  invitationRepo, passwordResetRepo
} = buildRepos(obsPool);

// Phase 8 - Ledger service. The single authority for balanced ledger
// postings; injected into every revenue-bearing command below.
const { buildLedgerService } = require('./services/finance/ledger');
const ledgerService = buildLedgerService({ ledgerRepo, revenueMapRepo, costCenterRepo, eventBus: eventBusRef });

// Phase 3 - build services. These MUST be constructed before any command is
// registered below: several command factories (invoices, vouchers,
// reservation groups) and the allocation sweep handler depend on
// `settingsService` / `scheduler`. (Previously these were declared further
// down; the resulting ReferenceError was swallowed by the boot try/catch
// blocks, silently skipping those command registrations.)
const { buildSettings }            = require('./services/settingsService');
const { buildFileService }         = require('./services/fileService');
const { buildConnectorRegistry }   = require('./services/connectorRegistry');
const { buildScheduler }           = require('./core/scheduler');
const { buildNotificationService } = require('./services/notificationService');
const { buildWebhookService }      = require('./services/webhookService');

const settingsService      = buildSettings({ repo: settingsRepo });
// Phase 6 / C14: register the typed settings catalog at boot.
const { bootstrapSettingsCatalog } = require('./services/settingsCatalogBoot');
try { bootstrapSettingsCatalog(); }
catch (e) { logger.warn({ err: e }, '[boot] settings catalog bootstrap skipped'); }
const fileService          = buildFileService({ repo: fileRepo });
const connectorRegistry    = buildConnectorRegistry({ repo: connectorRepo });
const scheduler            = buildScheduler({ repo: schedulerRepo });
const notificationService  = buildNotificationService({ repo: notificationRepo });
const webhookService       = buildWebhookService({ repo: webhookRepo });

// Phase 5 - PMS command + query registration
const queryBus = require('./core/queryBus');
const { makeCommands: makePmsCommands } = require('./commands/pms');
const { makeQueries:  makePmsQueries  } = require('./queries/pms');
try {
  for (const c of makePmsCommands({ pmsRepo })) commandBus.register(c);
  for (const q of makePmsQueries ({ pmsRepo, folioRepo, housekeepingRepo, nightAuditRepo })) queryBus.register(q);
} catch (e) { logger.warn({ err: e }, '[boot] PMS register skipped (already registered?)'); }

// Phase 21 - IAM read-only queries (users / roles) for the admin UI.
const { makeIamQueries } = require('./queries/iam');
try { for (const q of makeIamQueries({ identityRepo })) queryBus.register(q); }
catch (e) { logger.warn({ err: e }, '[boot] IAM query register skipped'); }

// Phase 5.5 - Night Audit + Check-In/Folio/Housekeeping commands
const { buildNightAuditService }      = require('./services/pms/nightAudit');
const { makeNightAuditCommands }      = require('./commands/pms/nightAudit');
const { makeCheckinFolioCommands }    = require('./commands/pms/checkinFolio');
const nightAuditService = buildNightAuditService({ nightAuditRepo, pmsRepo });

// Phase 6 / C4 - Meal Plan commands
const { makeMealPlanCommands } = require('./commands/pms/mealPlans');
try { for (const c of makeMealPlanCommands({ pmsRepo })) commandBus.register(c); }
catch (e) { logger.warn({ err: e }, '[boot] meal plan register skipped'); }

// Phase 7 / C8 - Payment Allocation
const { buildPaymentAllocationService }    = require('./services/pms/paymentAllocation');
const { makePaymentAllocationCommands }    = require('./commands/pms/paymentAllocation');
const paymentAllocationService = buildPaymentAllocationService({ folioRepo, pmsRepo });
try { for (const c of makePaymentAllocationCommands({ paymentAllocationService, ledgerService })) commandBus.register(c); }
catch (e) { logger.warn({ err: e }, '[boot] payment allocation register skipped'); }

// Phase 7 / C9 - Invoice aggregate (Phase 8: posts AR/Revenue ledger batch)
const { makeInvoiceCommands } = require('./commands/pms/invoices');
try { for (const c of makeInvoiceCommands({ folioRepo, pmsRepo, settingsService, ledgerService })) commandBus.register(c); }
catch (e) { logger.warn({ err: e }, '[boot] invoice register skipped'); }

// Phase 7 / C6 - Vouchers (Phase 8: posts discount/agent-cost ledger batch on redeem)
const { makeVoucherCommands } = require('./commands/pms/vouchers');
try { for (const c of makeVoucherCommands({ pmsRepo, settingsService, ledgerService })) commandBus.register(c); }
catch (e) { logger.warn({ err: e }, '[boot] voucher register skipped'); }

// Phase 7 / C5 - Reservation Group lifecycle
const { makeReservationGroupCommands } = require('./commands/pms/reservationGroups');
try { for (const c of makeReservationGroupCommands({ pmsRepo, commandBus, settingsService })) commandBus.register(c); }
catch (e) { logger.warn({ err: e }, '[boot] reservation_group register skipped'); }

// Phase 8 / C11 - Cost Centers
const { makeCostCenterCommands } = require('./commands/finance/costCenters');
try { for (const c of makeCostCenterCommands({ costCenterRepo })) commandBus.register(c); }
catch (e) { logger.warn({ err: e }, '[boot] cost_center register skipped'); }

// Phase 8 / C12 - Revenue Posting Map
const { makeRevenueMapCommands } = require('./commands/finance/revenueMap');
try { for (const c of makeRevenueMapCommands({ revenueMapRepo, costCenterRepo })) commandBus.register(c); }
catch (e) { logger.warn({ err: e }, '[boot] revenue_map register skipped'); }

// Phase 8 - Ledger commands (post / validate / revert)
const { makeLedgerCommands } = require('./commands/finance/ledger');
try { for (const c of makeLedgerCommands({ ledgerService })) commandBus.register(c); }
catch (e) { logger.warn({ err: e }, '[boot] ledger register skipped'); }

// Phase 8 finance queries (cost centers, revenue map, ledger reports).
const { makeQueries: makeFinanceQueries } = require('./queries/finance');
try { for (const q of makeFinanceQueries({ costCenterRepo, revenueMapRepo, ledgerRepo })) queryBus.register(q); }
catch (e) { logger.warn({ err: e }, '[boot] finance query register skipped'); }

// Phase 10.0 - Channel Manager foundation. Adapters registered in the registry;
// events flow through the shared eventBus (ChannelEventBus default) into
// audit_events + event_store.
const { ChannelManagerCore } = require('./channel-manager/core/ChannelManagerCore');
const { BookingComAdapter } = require('./channel-manager/adapters/bookingcom/BookingComAdapter');
const { QTCNAdapter } = require('./channel-manager/adapters/qyrcn/QTCNAdapter');
const { AgodaAdapter } = require('./channel-manager/adapters/agoda/AgodaAdapter');
const { ExpediaAdapter } = require('./channel-manager/adapters/expedia/ExpediaAdapter');
const { AirbnbAdapter } = require('./channel-manager/adapters/airbnb/AirbnbAdapter');
// Phase 49: three new OTA stub adapters (not_configured until credentials obtained)
const { MakeMyTripAdapter } = require('./channel-manager/adapters/makemytrip/MakeMyTripAdapter');
const { GoogleAdapter }     = require('./channel-manager/adapters/google/GoogleAdapter');
const { TripAdvisorAdapter }= require('./channel-manager/adapters/tripadvisor/TripAdvisorAdapter');
let channelManager = null;
try {
  channelManager = new ChannelManagerCore();
  channelManager.registerAdapter(new QTCNAdapter());         // QYRVIA Connect — QYRVIA-owned B2B OTA/distribution platform
  channelManager.registerAdapter(new BookingComAdapter());   // working mock
  channelManager.registerAdapter(new AgodaAdapter());        // stubs (contract-complete)
  channelManager.registerAdapter(new ExpediaAdapter());
  channelManager.registerAdapter(new AirbnbAdapter());
  channelManager.registerAdapter(new MakeMyTripAdapter());   // Phase 49 stubs
  channelManager.registerAdapter(new GoogleAdapter());
  channelManager.registerAdapter(new TripAdvisorAdapter());
} catch (e) { logger.warn({ err: e }, '[boot] channel manager init skipped'); }

// Phase 17 - Revenue Management (deterministic dynamic pricing + forecasting).
// Read-only consumer of upstream events; no schema, no AI.
const { buildMemoryRevenueRepo } = require('./revenue/repository/revenueRepo.memory');
const { buildRevenueEngine } = require('./revenue/core/RevenueEngine');
const { buildRevenueSubscriber } = require('./revenue/services/revenueSubscriber');
let revenue = null;
try {
  revenue = buildRevenueEngine({ repo: buildMemoryRevenueRepo() });
  buildRevenueSubscriber({ eventBus: eventBusRef, revenue });
} catch (e) { logger.warn({ err: e }, '[boot] revenue init skipped'); }

// Phase 18 - Enterprise Platform Layer (IAM, gateway, observability, integration,
// enterprise control). Additive cross-cutting layer; consumes events read-only.
const { buildPlatformLayer } = require('./platform/PlatformLayer');
const { buildPlatformSubscriber } = require('./platform/services/platformSubscriber');
let platform = null;
try {
  platform = buildPlatformLayer({});
  buildPlatformSubscriber({ eventBus: eventBusRef, platform });
} catch (e) { logger.warn({ err: e }, '[boot] platform init skipped'); }

// Phase 24 S4/B3 - Channel persistence foundation. Default CHANNEL_PERSISTENCE='memory',
// so this is behavior-identical to before. 'dual' additionally mirrors queue writes to the
// DB (memory authoritative); 'db' is reserved for the async worker stage (B6+).
const { buildChannelPersistence } = require('./channel-manager/persistence');
let channelPersistence = null;
try {
  channelPersistence = buildChannelPersistence({ db: db.pool });
  logger.info({ mode: channelPersistence.mode }, '[boot] channel persistence');
} catch (e) { logger.warn({ err: e }, '[boot] channel persistence init skipped'); }

// Phase 34: queue-depth gauge from the existing channel sync queue (memory mode
// exposes a synchronous size()). Read live at snapshot time; never throws.
try {
  observability.metrics.bindQueueDepthProvider(() => {
    const out = {};
    const q = channelPersistence && channelPersistence.queue;
    if (q && typeof q.size === 'function') {
      try { out.channel_sync = q.size(); } catch (_) { /* ignore */ }
    }
    return out;
  });
} catch (_) { /* telemetry only */ }

// Phase 24 B8-B1 - secure OTA credential foundation (DI only). The SecretProvider
// exists only when CHANNEL_CREDENTIAL_KEY is set; default boot => dormant, no provider.
const { buildChannelCredentials } = require('./channel-manager/credentials');
let channelCredentials = null;
try {
  channelCredentials = buildChannelCredentials({ db: db.pool });
  logger.info({ mode: channelCredentials.mode, hasProvider: channelCredentials.hasProvider }, '[boot] channel credentials');
} catch (e) { logger.warn({ err: e }, '[boot] channel credentials init skipped'); }

// Phase 24 B8-B2 - channel mapping management (versioning + history + audit). DI only;
// reuses the persistence mapping store. Internal data; no OTA calls. Dormant until used.
const { buildChannelMappingManagement } = require('./channel-manager/mapping');
let channelMapping = null;
try {
  channelMapping = buildChannelMappingManagement({ db: db.pool, mappingStore: channelPersistence && channelPersistence.mapping });
  logger.info({ mode: channelMapping.mode }, '[boot] channel mapping management');
} catch (e) { logger.warn({ err: e }, '[boot] channel mapping init skipped'); }

// Phase 49 - channel registry service (per-tenant OTA enable/status store).
// DB-backed via channel_registry table (migration 0055). Graceful: if table
// not yet migrated, the route handlers return empty list, never crash.
const { buildChannelRegistryRepoDb } = require('./channel-manager/registry/channelRegistryRepo.db');
const { buildChannelRegistryService } = require('./channel-manager/registry/channelRegistryService');
let channelRegistry = null;
try {
  const registryRepo = buildChannelRegistryRepoDb({ db: db.pool });
  channelRegistry = buildChannelRegistryService({ repo: registryRepo });
  logger.info('[boot] channel registry ready');
} catch (e) { logger.warn({ err: e }, '[boot] channel registry init skipped'); }

// Phase 24 B8-B3 - outbound sync (real QYRVIA_CONNECT via in-process transport; third-party OTAs
// mock + HTTP transport disabled). DI only; delta-aware. No external network, no webhooks.
const { buildChannelOutboundSync } = require('./channel-manager/sync');
let channelOutboundSync = null;
try {
  // B8-B5: third-party OTAs use real HttpTransport only when activated (CHANNEL_OTA_ACTIVATIONS)
  // AND CHANNEL_HTTP_ENABLED=true; default off => no external network. Auth via SecretProvider.
  // Phase 53 H2: inject channelRegistry for kill-switch enforcement at outbound sync.
  channelOutboundSync = buildChannelOutboundSync({ db: db.pool, secretProvider: channelCredentials && channelCredentials.provider, channelRegistry });
  logger.info({ mode: channelOutboundSync.mode, realChannels: Array.from(channelOutboundSync.realChannels), http: channelOutboundSync.httpChannels }, '[boot] channel outbound sync');
} catch (e) { logger.warn({ err: e }, '[boot] channel outbound sync init skipped'); }

// Phase 24 B8-B4 - inbound webhook pipeline (idempotent booking_store -> PMS commandBus).
// DI only; the route is mounted gated behind CHANNEL_WEBHOOK_ENABLED (default off).
const { buildChannelInbound } = require('./channel-manager/inbound');
let channelInbound = null;
try {
  // Phase 53 H1: inject ariAvailabilityProvider for OTA booking availability gate.
  // Phase 53 H2: inject channelRegistry for kill-switch enforcement at inbound.
  let _ariAvailabilityProvider;
  try { if (ariService) _ariAvailabilityProvider = buildAriAvailabilityProvider({ ariService }); } catch (_) { /* optional */ }
  channelInbound = buildChannelInbound({
    registry:             channelOutboundSync && channelOutboundSync.registry,
    bookingStore:         channelPersistence && channelPersistence.booking,
    commandBus,
    resolveSecret:        channelOutboundSync && channelOutboundSync.resolveSecret, // B8-B5: per-channel signing secret
    requireSignature:     env.CHANNEL_WEBHOOK_REQUIRE_SIGNATURE !== 'false',
    availabilityProvider: _ariAvailabilityProvider || null,  // H1: ARI gate (null = disabled)
    channelRegistry:      channelRegistry || null,           // H2: kill-switch (null = disabled)
    importLog:            channelPersistence && channelPersistence.importLog || null  // Fix 3: booking import log
  });
  logger.info('[boot] channel inbound pipeline ready');
} catch (e) { logger.warn({ err: e }, '[boot] channel inbound init skipped'); }

// Phase 52 D8 — ARI store + service boot. Wired from the DB pool; graceful on failure.
// Boot order: DB pool -> ARI store -> ARI service -> inject into booking engine + routes.
const { buildDbAriStore } = require('./ari/store/dbStore');
const { buildAriService } = require('./ari/ariService');
const { buildAriRateResolver } = require('./booking-engine/ariRateResolver');
const { buildAriAvailabilityProvider } = require('./booking-engine/ariAvailabilityProvider');
const { buildAriInventoryAdjuster } = require('./booking-engine/ariInventoryAdjuster');

// Phase 54 D8 — Payment infrastructure. DB-backed when pool available; memory fallback otherwise.
const { buildPaymentProvider }         = require('./payment/buildPaymentProvider');
const { buildPaymentStateStoreMemory } = require('./payment/paymentStateStore');
const { buildPaymentStateStoreDb }     = require('./payment/paymentStateStoreDb');
const { buildPaymentAttemptLogMemory } = require('./payment/paymentAttemptLog');
const { buildPaymentAttemptLogDb }     = require('./payment/paymentAttemptLogDb');
let ariDbStore = null;
let ariService = null;
try {
  ariDbStore = buildDbAriStore({ db: obsPool });
  ariService = buildAriService({ store: ariDbStore });
  logger.info('[boot] ARI store + service ready');
} catch (e) { logger.warn({ err: e }, '[boot] ARI init skipped'); }

// Phase 27.3 - AI Booking Confirmation. Default OFF. When enabled, builds the
// confirmation service (deterministic templates, escalation decision tree, retry/DLQ
// queue, MOCK transport - no external calls) and hands its onEvent hook to the
// Booking Engine below. When disabled, onEvent stays undefined => zero overhead and
// no behavior change. Rollback: AI_CONFIRMATION_ENABLED=false (no code removal).
let aiConfirmation = null;
if (require('./config/env').AI_CONFIRMATION_ENABLED === 'true') {
  try {
    const { buildAiConfirmation } = require('./ai-confirmation');
    aiConfirmation = buildAiConfirmation({});
    logger.info('[boot] AI booking confirmation ready');
  } catch (e) { logger.warn({ err: e }, '[boot] ai confirmation init skipped'); }
} else {
  logger.info('[boot] AI booking confirmation disabled (AI_CONFIRMATION_ENABLED=false)');
}

// Booking Engine v1 - unified orchestration gate for ALL reservation creation
// (Direct / OTA / AI / Front Desk). Pure orchestration via commandBus; reuses
// booking_store idempotency. DI only; no PMS/OTA/worker/queue/webhook/UI changes.
// Phase 52 D8: inject ARI rate resolver, availability provider, and inventory adjuster
// when ariService/ariStore are available; fall back to flat-rate behavior otherwise.
// Phase 54 D8: inject payment provider, payment state store, payment attempt log.
const { buildBookingEngine } = require('./booking-engine');

// Phase 54: construct payment infrastructure (DB-backed when pool available).
let paymentProvider    = null;
let paymentStateStore  = null;
let paymentAttemptLog  = null;
try {
  paymentProvider   = buildPaymentProvider({ config: { provider: env.PAYMENT_PROVIDER || 'mock' } });
  paymentStateStore = obsPool ? buildPaymentStateStoreDb({ db: obsPool }) : buildPaymentStateStoreMemory();
  paymentAttemptLog = obsPool ? buildPaymentAttemptLogDb({ db: obsPool }) : buildPaymentAttemptLogMemory();
  logger.info({ provider: env.PAYMENT_PROVIDER || 'mock' }, '[boot] payment infrastructure ready');
} catch (e) { logger.warn({ err: e }, '[boot] payment infrastructure init skipped'); }

let bookingEngine = null;
try {
  let ariRateResolver;
  let ariAvailabilityProvider;
  let ariInventoryAdjuster;
  try {
    if (ariService) ariRateResolver = buildAriRateResolver({ ariService });
    if (ariService) ariAvailabilityProvider = buildAriAvailabilityProvider({ ariService });
    if (ariDbStore) ariInventoryAdjuster = buildAriInventoryAdjuster({ ariStore: ariDbStore });
  } catch (e) { logger.warn({ err: e }, '[boot] ARI booking-engine adapters init skipped'); }

  // Phase 56: confirmation delivery service (persistent outbox).
  let _confirmationDeliveryService = null;
  try {
    const { buildConfirmationDeliveryService } = require('./payment/confirmationDeliveryService');
    const { confirmationDeliveryRepo } = repos;
    if (confirmationDeliveryRepo && pmsRepo && pmsRepo.setReservationConfirmationSent) {
      _confirmationDeliveryService = buildConfirmationDeliveryService({
        repo: confirmationDeliveryRepo,
        setReservationConfirmationSent: (tid, id, sentAt) =>
          pmsRepo.setReservationConfirmationSent(tid, id, sentAt),
      });
      // Drive pending delivery worker every 5 minutes (same cadence as hold sweep).
      setInterval(() => {
        _confirmationDeliveryService.processPendingDeliveries({ limit: 25 })
          .catch((err) => logger.error({ err }, '[boot] processPendingDeliveries failed'));
      }, 5 * 60 * 1000);
      logger.info('[boot] confirmation delivery service ready');
    }
  } catch (e) { logger.warn({ err: e }, '[boot] confirmation delivery service init skipped'); }

  bookingEngine = buildBookingEngine({
    commandBus,
    bookingStore: channelPersistence && channelPersistence.booking,
    pmsRepo, // Phase 37 WI-1b: back the fail-closed availability guard with real PMS inventory
    rateResolver:          ariRateResolver          || undefined,
    availabilityProvider:  ariAvailabilityProvider  || undefined,
    inventoryAdjuster:     ariInventoryAdjuster     || undefined,
    ariService,
    ariStore: ariDbStore,
    onEvent: aiConfirmation && aiConfirmation.onEvent, // Phase 27.3: undefined when confirmation is OFF
    paymentProvider,    // Phase 54 D8
    paymentStateStore,  // Phase 54 D8
    paymentAttemptLog,  // Phase 54 D8
    findReservationByIdempotencyKey: pmsRepo && pmsRepo.findReservationByIdempotencyKey  // Phase 55
      ? (tid, key) => pmsRepo.findReservationByIdempotencyKey(tid, key)
      : null,
    confirmationDeliveryService: _confirmationDeliveryService,  // Phase 56
  });
  logger.info('[boot] booking engine ready');
} catch (e) { logger.warn({ err: e }, '[boot] booking engine init skipped'); }

// Phase 57 — Commercial SaaS Identity: invitation, password-reset, and tenant provisioning.
let invitationService = null;
let passwordResetService = null;
let tenantProvisioningService = null;
try {
  const { buildInvitationService }        = require('./services/invitation');
  const { buildPasswordResetService }     = require('./services/passwordReset');
  const { buildTenantProvisioningService } = require('./services/tenantProvisioning');

  // Invitation service repo: merge invitation-specific methods + identity helpers
  const invRepo = Object.assign({}, invitationRepo, {
    findUserByEmailGlobal:    (...a) => identityRepo.findUserByEmailGlobal(...a),
    insertUser:               (...a) => identityRepo.insertUser(...a),
    insertUserRoleByCode:     (...a) => identityRepo.insertUserRoleByCode(...a),
    revokeAllRefreshTokensForUser: (...a) => tokensRepo.revokeAllRefreshTokensForUser(...a)
  });
  invitationService = buildInvitationService({ repo: invRepo });

  // Password-reset service repo: merge reset methods + identity/token helpers
  const resetRepo = Object.assign({}, passwordResetRepo, {
    findUserByEmailGlobal:                  (...a) => identityRepo.findUserByEmailGlobal(...a),
    revokeAllRefreshTokensForUser:          (...a) => tokensRepo.revokeAllRefreshTokensForUser(...a)
  });
  passwordResetService = buildPasswordResetService({ repo: resetRepo });

  // Tenant provisioning: transactional via obsPool, invitation via invitationService
  if (obsPool) {
    tenantProvisioningService = buildTenantProvisioningService({
      pool: obsPool, invitationService
    });
  }

  logger.info('[boot] Phase 57 identity services ready');
} catch (e) { logger.warn({ err: e }, '[boot] Phase 57 identity services init skipped'); }

// Phase 55 — Hold expiry sweep: cancel reservations whose payment hold has
// expired without a completed payment. Registered after bookingEngine so that
// paymentStateStore and commandBus are already initialised.
try {
  const { buildHoldExpirySweep } = require('./payment/holdExpirySweep');
  const { withTenant: _withTenantForSweep } = require('./db/client');
  const holdExpirySweep = buildHoldExpirySweep({
    paymentStateStore,
    commandBus,
    withTenantFn: obsPool ? _withTenantForSweep : null,
  });
  scheduler.registerHandler('booking.hold.expire_sweep', async (_payload, ctx) => {
    return holdExpirySweep.sweep(ctx);
  });
  // Auto-drive the scheduler every 5 minutes so hold expiry runs without an
  // external cron caller. executeDueJobs uses FOR UPDATE SKIP LOCKED — safe to
  // call concurrently from multiple process instances.
  setInterval(() => {
    scheduler.executeDueJobs({ limit: 50 })
      .catch((err) => logger.error({ err }, '[boot] executeDueJobs failed'));
  }, 5 * 60 * 1000);
  logger.info('[boot] hold expiry sweep registered (every 5 min)');
} catch (e) { logger.warn({ err: e }, '[boot] hold expiry sweep init skipped'); }

// Phase 27 - AI WhatsApp Booking Agent (foundation, MOCK provider). Consumes the
// Booking Engine only; no direct PMS/OTA writes, no real AI/WhatsApp. Default OFF.
if (require('./config/env').AI_AGENT_ENABLED === 'true' && bookingEngine && bookingEngine.service) {
  try {
    const aiEnv = require('./config/env');
    const { buildAiAgent } = require('./ai-agent');
    // Phase 27.1A: multi-provider chain (anthropic -> openai -> gemini -> mock). Vendor HTTP
    // is default-disabled (AI_LLM_ENABLED); keys resolve via the SecretProvider at execution.
    const providerOpts = {
      secretProvider: channelCredentials && channelCredentials.provider,
      credentialsRef: aiEnv.AI_LLM_CREDENTIALS_REF, endpoint: aiEnv.AI_LLM_ENDPOINT,
      model: aiEnv.AI_LLM_MODEL, httpEnabled: aiEnv.AI_LLM_ENABLED === 'true'
    };
    buildAiAgent({ bookingService: bookingEngine.service, providerKind: aiEnv.AI_PROVIDER, providerOpts });
    logger.info({ primary: aiEnv.AI_PROVIDER, fallback: aiEnv.AI_FALLBACK_PROVIDER, tertiary: aiEnv.AI_TERTIARY_PROVIDER, llmEnabled: aiEnv.AI_LLM_ENABLED === 'true' }, '[boot] AI WhatsApp agent ready');
  } catch (e) { logger.warn({ err: e }, '[boot] ai agent init skipped'); }
} else {
  logger.info('[boot] AI WhatsApp agent disabled (AI_AGENT_ENABLED=false)');
}

// Phase 24 S1/B5 - Channel Manager event spine (PMS -> CM). LISTEN + ROUTE + LOG, and
// enqueue onto the mode-selected sync queue. memory/dual return synchronously (behavior
// preserved); idempotent registration (no dup listeners).
const { buildChannelSubscriber } = require('./channel-manager/services/channelSubscriber');
try { buildChannelSubscriber({ eventBus: eventBusRef, queue: channelPersistence && channelPersistence.queue }); }
catch (e) { logger.warn({ err: e }, '[boot] channel spine init skipped'); }

// Phase 24 B6 - durable queue worker (MOCK processor, NO OTA). Default OFF: starts only
// when CHANNEL_WORKER_ENABLED=true. Infrastructure only; not wired to real processing.
if (require('./config/env').CHANNEL_WORKER_ENABLED === 'true') {
  try {
    const { buildLeaseQueue } = require('./channel-manager/worker/leaseQueue');
    const { buildMockProcessor } = require('./channel-manager/worker/mockProcessor');
    const { buildChannelQueueWorker } = require('./channel-manager/worker/channelQueueWorker');
    const channelWorker = buildChannelQueueWorker({
      queue: buildLeaseQueue(),
      processor: buildMockProcessor(),
      deadLetterStore: channelPersistence && channelPersistence.deadLetter,
      enabled: true
    });
    channelWorker.start();
  } catch (e) { logger.warn({ err: e }, '[boot] channel worker init skipped'); }
} else {
  logger.info('[boot] channel queue worker disabled (CHANNEL_WORKER_ENABLED=false)');
}

// Phase 7 / C7 - Allocation lifecycle (commands + subscribers + sweep job)
const { buildAllocationService } = require('./services/pms/allocation');
const { makeAllocationCommands } = require('./commands/pms/allocations');
const allocationService = buildAllocationService({ pmsRepo, eventBus: require('./core/eventBus') });
try { for (const c of makeAllocationCommands({ pmsRepo, allocationService })) commandBus.register(c); }
catch (e) { logger.warn({ err: e }, '[boot] allocation register skipped'); }

// Subscribers: reservation.created -> auto-consume allocation when payload.allocation_id present.
eventBusRef.subscribe('reservation.created', async (event) => {
  try {
    const allocId = event.payload && event.payload.allocation_id;
    if (!allocId) return;
    await allocationService.consume({ tenantId: event.tenant_id, allocationId: allocId, qty: 1,
      ctx: { tenantId: event.tenant_id, propertyId: event.property_id, requestId: 'sub-' + event.event_id } });
  } catch (e) { logger.error({ err: e, event_id: event.event_id }, '[boot] allocation consume failed'); }
});
eventBusRef.subscribe('reservation.cancelled', async (event) => {
  try {
    const allocId = event.payload && event.payload.allocation_id;
    if (!allocId) return;
    await allocationService.decrement({ tenantId: event.tenant_id, allocationId: allocId, qty: 1,
      ctx: { tenantId: event.tenant_id, propertyId: event.property_id, requestId: 'sub-' + event.event_id } });
  } catch (e) { logger.error({ err: e, event_id: event.event_id }, '[boot] allocation decrement failed'); }
});

// Register scheduler handler for the recurring sweep job.
try {
  scheduler.registerHandler('pms.allocation.release_sweep', async (job) => {
    const ctx = { requestId: 'sched-' + job.id, tenantId: job.tenant_id, propertyId: job.property_id,
                  actorId: null, actorName: 'AllocationSweeper',
                  roleCodes: ['system'], permissions: ['allocation.release'],
                  businessDate: null, businessDateLocked: false };
    return commandBus.dispatch('pms.allocation.release_sweep', {}, ctx);
  });
} catch (e) { logger.warn({ err: e }, '[boot] allocation sweep handler skipped'); }

// Wire the auth.user.create command to its repo + register on the bus.
const authUserCreate = require('./commands/auth.user.create');
authUserCreate.setRepo(identityRepo);
try { commandBus.register(authUserCreate); }
catch (e) { logger.warn({ err: e }, '[boot] commandBus register skipped (already registered?)'); }

// Phase 6 / C13 - Night Audit Scheduler (recurring job + stale-date sweep).
const { buildNightAuditScheduler, JOB_TYPE_NIGHT_AUDIT, JOB_TYPE_STALE_CHECK }
  = require('./services/pms/nightAuditScheduler');
const nightAuditScheduler = buildNightAuditScheduler({
  schedulerRepo, scheduler, pmsRepo,
  eventBus: require('./core/eventBus'),
  settingsService, commandBus
});

// Register handler so a due job dispatches pms.night_audit.run through the bus.
try {
  scheduler.registerHandler(JOB_TYPE_NIGHT_AUDIT, async (job) => {
    const ctx = {
      requestId:  'sched-' + job.id,
      tenantId:   job.tenant_id,
      propertyId: job.property_id,
      actorId:    job.created_by || null,
      actorName:  'NightAuditScheduler',
      roleCodes:  ['system'], permissions: ['night_audit.run'],
      // businessDate is populated by the command handler from the property
      businessDate: null, businessDateLocked: false
    };
    // The scheduled handler doesn't have ctx.businessDate; we ask the repo.
    const propDate = await pmsRepo.findPropertyById(job.tenant_id, job.property_id);
    if (propDate && propDate.current_business_date) {
      ctx.businessDate = String(propDate.current_business_date).slice(0, 10);
    }
    return commandBus.dispatch('pms.night_audit.run', {}, ctx);
  });
  scheduler.registerHandler(JOB_TYPE_STALE_CHECK, async (job) => {
    const settings = await settingsService.get('night_audit', 'stale_threshold_hours',
      { ctx: { tenantId: job.tenant_id, propertyId: job.property_id, requestId: 'stale-' + job.id }, default: 24 });
    return nightAuditScheduler.runStaleCheck({ thresholdHours: Number(settings) || 24 });
  });
} catch (e) { logger.warn({ err: e }, '[boot] night audit scheduler handlers skipped'); }

// Now register all Phase 5.5 + 6 commands (after scheduler is built).
try {
  for (const c of makeNightAuditCommands  ({ nightAuditService, nightAuditScheduler })) commandBus.register(c);
  for (const c of makeCheckinFolioCommands({ pmsRepo, folioRepo, housekeepingRepo }))   commandBus.register(c);
} catch (e) { logger.warn({ err: e }, '[boot] Phase 5.5 register skipped (already registered?)'); }

// Wire the webhook service to receive domain events
eventBusRef.subscribe('*', async (event) => {
  // Only fan out domain events (not command.*/query.*) to webhooks
  const t = String(event.event_type || '');
  if (t.startsWith('command.') || t.startsWith('query.') || t.startsWith('authz.')) return;
  try { await webhookService.enqueue(event); }
  catch (err) { logger.error({ err, event_type: event.event_type }, '[boot] webhook enqueue failed'); }
});

// Helper to build an auth.* audit event from a route handler context.
function makeAuthEvent(type, payload, req, user) {
  // We need a synthetic ctx since this fires outside the standard
  // identityContext middleware. Tenant id must be present, requestId must be present.
  const tenantId = (user && user.tenant_id) ||
                   (req.user && req.user.tenant_id) ||
                   '00000000-0000-0000-0000-000000000000';
  return makeEvent({
    type,
    aggregateType: 'auth',
    aggregateId:   (user && user.id) || (req.user && req.user.sub) || 'anonymous',
    payload:       payload || {},
    ctx: {
      tenantId:   tenantId,
      propertyId: (user && user.primary_property_id) || null,
      actorId:    (user && user.id) || (req.user && req.user.sub) || null,
      requestId:  req.requestId
    }
  });
}

const app = createApp({
  db: dbFacade,
  identityRepo,
  tokensRepo,
  settingsService, fileService, connectorRegistry, scheduler,
  notificationService, webhookService,
  commandBus, queryBus,
  eventBus: require('./core/eventBus'),
  channelManager,
  channelPersistence,
  channelCredentials,
  channelMapping,
  channelRegistry,    // Phase 49
  channelOutboundSync,
  channelInbound,
  bookingEngine,
  aiConfirmation, // Phase 27.3: null when AI_CONFIRMATION_ENABLED=false
  revenue,
  platform,
  ariService,     // Phase 52: ARI management API + booking engine pricing
  ariStore: ariDbStore, // Phase 52: ARI inventory grid writes
  makeAuthEvent,
  // Phase 57: commercial SaaS identity
  invitationService,
  passwordResetService,
  tenantProvisioningService
});

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, '[qyrvia] listening');
});

function shutdown(signal) {
  logger.info({ signal }, '[qyrvia] shutdown requested');
  server.close(async (err) => {
    if (err) logger.error({ err }, '[qyrvia] http close error');
    try { await db.close(); } catch (e) { logger.error({ err: e }, '[qyrvia] db close error'); }
    logger.info('[qyrvia] shutdown complete');
    process.exit(err ? 1 : 0);
  });
  setTimeout(() => {
    logger.error('[qyrvia] forced exit after 10s');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[qyrvia] unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, '[qyrvia] uncaughtException - exiting');
  process.exit(1);
});
