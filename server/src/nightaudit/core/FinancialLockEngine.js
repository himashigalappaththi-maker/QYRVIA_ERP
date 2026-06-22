'use strict';

/**
 * FinancialLockEngine - restricts ONLY accounting-sensitive functions while a
 * day-end is in progress. Operational modules (front desk, reservations,
 * housekeeping, room status, billing inquiry) always remain available - this is
 * the QYRVIA operational-continuity rule.
 */

const { makeLock, LOCK_STATUS } = require('../models/NightAuditModels');

let makeEvent = null;
try { ({ makeEvent } = require('../../core/event')); } catch (_) { /* optional */ }

function buildFinancialLockEngine({ repo, eventBus } = {}) {
  if (!repo) throw new Error('FinancialLockEngine: repo required');
  const requireProperty = (ctx) => { if (!ctx || !ctx.propertyId) throw new Error('property_required'); return ctx.propertyId; };

  async function emit(type, aggregateId, payload, ctx) {
    if (!eventBus || !makeEvent || !ctx || !ctx.tenantId || !ctx.requestId) return;
    try { await eventBus.publish(makeEvent({ type, aggregateType: 'financial', aggregateId: String(aggregateId), payload, ctx })); }
    catch (_) { /* events must not corrupt state */ }
  }

  return {
    async lockAccountingFunctions(ctx, { businessDate, modules } = {}) {
      const propertyId = requireProperty(ctx);
      const lock = makeLock({ propertyId, businessDate,
        lockStatus: LOCK_STATUS.LOCKED, lockedModules: modules || ['POSTING', 'PAYMENT', 'INVOICE', 'LEDGER'] });
      const saved = await repo.saveLock(lock);
      await emit('financial.locked', propertyId, { property_id: propertyId, business_date: businessDate, modules: saved.lockedModules }, ctx);
      return saved;
    },

    async unlockAccountingFunctions(ctx) {
      const propertyId = requireProperty(ctx);
      const lock = makeLock({ propertyId, lockStatus: LOCK_STATUS.UNLOCKED, lockedModules: [] });
      const saved = await repo.saveLock(lock);
      await emit('financial.unlocked', propertyId, { property_id: propertyId }, ctx);
      return saved;
    },

    async isLocked(ctx) {
      const lock = await repo.getLock(requireProperty(ctx));
      return !!lock && lock.lockStatus === LOCK_STATUS.LOCKED;
    },

    /** Operational-continuity guard: only accounting-sensitive ops are blocked. */
    async isOperationAllowed(ctx, { accountingSensitive = false } = {}) {
      if (!accountingSensitive) return true;             // operational ops always allowed
      return !(await this.isLocked(ctx));
    }
  };
}

module.exports = { buildFinancialLockEngine };
