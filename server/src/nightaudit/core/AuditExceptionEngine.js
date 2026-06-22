'use strict';

/**
 * AuditExceptionEngine - records audit warnings + blocking exceptions and their
 * resolution history. Categories: FINANCIAL | OPERATIONAL | BILLING | SYSTEM.
 */

const crypto = require('crypto');
const { EXCEPTION_CATEGORY } = require('../models/NightAuditModels');

let makeEvent = null;
try { ({ makeEvent } = require('../../core/event')); } catch (_) { /* optional */ }

function buildAuditExceptionEngine({ repo, eventBus } = {}) {
  if (!repo) throw new Error('AuditExceptionEngine: repo required');
  const requireProperty = (ctx) => { if (!ctx || !ctx.propertyId) throw new Error('property_required'); return ctx.propertyId; };

  async function emit(payload, ctx) {
    if (!eventBus || !makeEvent || !ctx || !ctx.tenantId || !ctx.requestId) return;
    try { await eventBus.publish(makeEvent({ type: 'audit.exception', aggregateType: 'audit', aggregateId: String(payload.id), payload, ctx })); }
    catch (_) { /* events must not corrupt state */ }
  }

  return {
    async raise(ctx, { category, code, message, blocking = false, businessDate, source = 'MANUAL' } = {}) {
      const propertyId = requireProperty(ctx);
      if (!EXCEPTION_CATEGORY[category]) throw new Error('invalid_exception_category');
      const ex = await repo.insertException({
        id: crypto.randomUUID(), propertyId, category, code: code || category,
        message: message || code || category, blocking: !!blocking, businessDate: businessDate || null,
        source,                                  // MANUAL (external) | VALIDATION (audit-derived, audit trail only)
        resolved: false, resolution: null, createdAt: new Date().toISOString()
      });
      await emit({ id: ex.id, property_id: propertyId, category, code: ex.code, blocking: ex.blocking }, ctx);
      return ex;
    },

    async resolve(ctx, id, { resolution } = {}) {
      requireProperty(ctx);
      return repo.updateException(id, { resolved: true, resolution: resolution || null, resolvedAt: new Date().toISOString() });
    },

    async list(ctx, filter) { return repo.listExceptions(requireProperty(ctx), filter || {}); }
  };
}

module.exports = { buildAuditExceptionEngine };
