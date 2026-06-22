'use strict';

/**
 * NightAuditSystem - facade composing the Business Date architecture:
 * BusinessDateEngine, FinancialLockEngine, AuditExceptionEngine,
 * AuditValidationEngine, NightAuditEngine, DayEndScheduler, NightAuditDashboard.
 *
 * Additive / self-contained; consumes upstream phases via events only.
 */

const { buildBusinessDateEngine } = require('./BusinessDateEngine');
const { buildFinancialLockEngine } = require('./FinancialLockEngine');
const { buildAuditExceptionEngine } = require('./AuditExceptionEngine');
const { buildAuditValidationEngine } = require('./AuditValidationEngine');
const { buildNightAuditEngine } = require('./NightAuditEngine');
const { buildDayEndScheduler } = require('./DayEndScheduler');
const { buildNightAuditDashboard } = require('./NightAuditDashboard');

function buildNightAuditSystem({ repo, eventBus, clock } = {}) {
  if (!repo) throw new Error('NightAuditSystem: repo required');
  const businessDate = buildBusinessDateEngine({ repo, eventBus });
  const lock = buildFinancialLockEngine({ repo, eventBus });
  const exceptions = buildAuditExceptionEngine({ repo, eventBus });
  const validation = buildAuditValidationEngine({ repo });
  const audit = buildNightAuditEngine({ repo, businessDate, validation, lock, exceptions, eventBus, clock });
  const scheduler = buildDayEndScheduler({ nightAudit: audit, repo, clock });
  const dashboard = buildNightAuditDashboard({ repo, lock });
  return { repo, businessDate, lock, exceptions, validation, audit, scheduler, dashboard };
}

module.exports = { buildNightAuditSystem };
