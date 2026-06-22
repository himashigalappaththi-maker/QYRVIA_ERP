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

/**
 * DB facade for the app. Exposes only what the kernel needs:
 *   - ping()                       : used by /api/health/ready
 *   - insertAuditEvent(event)      : used by eventBus.persistToAudit
 */
const dbFacade = {
  ping: db.ping,
  async insertAuditEvent(ev) {
    await db.pool.query(
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
    await db.pool.query(
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
  costCenterRepo, revenueMapRepo, ledgerRepo
} = buildRepos(db.pool);

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
  for (const q of makePmsQueries ({ pmsRepo, folioRepo })) queryBus.register(q);
} catch (e) { logger.warn({ err: e }, '[boot] PMS register skipped (already registered?)'); }

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
  makeAuthEvent
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
