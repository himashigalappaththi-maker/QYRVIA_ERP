'use strict';

/**
 * BusinessDateEngine - per-property business date + status
 * (OPEN / AUDIT_PENDING / CLOSED). Closing a day advances the business date to
 * the next day and records the audit attribution.
 */

const { makeBusinessDate, nextDate, DATE_STATUS } = require('../models/NightAuditModels');

let makeEvent = null;
try { ({ makeEvent } = require('../../core/event')); } catch (_) { /* optional */ }

function buildBusinessDateEngine({ repo, eventBus } = {}) {
  if (!repo) throw new Error('BusinessDateEngine: repo required');
  const requireProperty = (ctx) => { if (!ctx || !ctx.propertyId) throw new Error('property_required'); return ctx.propertyId; };
  const userOf = (ctx) => (ctx && (ctx.userId || ctx.actorId)) || null;

  async function emit(type, aggregateId, payload, ctx) {
    if (!eventBus || !makeEvent || !ctx || !ctx.tenantId || !ctx.requestId) return;
    try { await eventBus.publish(makeEvent({ type, aggregateType: 'business_date', aggregateId: String(aggregateId), payload, ctx })); }
    catch (_) { /* events must not corrupt state */ }
  }

  async function getOrThrow(propertyId) {
    const bd = await repo.getBusinessDate(propertyId);
    if (!bd) throw new Error('business_date_not_initialized');
    return bd;
  }

  return {
    async setBusinessDate(ctx, date) {
      const propertyId = requireProperty(ctx);
      const bd = makeBusinessDate({ propertyId, currentBusinessDate: date, status: DATE_STATUS.OPEN });
      const saved = await repo.saveBusinessDate(bd);
      await emit('businessdate.changed', propertyId, { property_id: propertyId, business_date: date, status: saved.status }, ctx);
      return saved;
    },

    async getBusinessDate(ctx) { return repo.getBusinessDate(requireProperty(ctx)); },
    async getStatus(ctx) { const bd = await getOrThrow(requireProperty(ctx)); return bd.status; },

    async markPending(ctx) {
      const propertyId = requireProperty(ctx);
      const bd = await getOrThrow(propertyId);
      bd.status = DATE_STATUS.AUDIT_PENDING;
      const saved = await repo.saveBusinessDate(bd);
      await emit('businessdate.changed', propertyId, { property_id: propertyId, business_date: bd.currentBusinessDate, status: saved.status }, ctx);
      return saved;
    },

    /** Close the current day and advance to the next business date. */
    async markClosed(ctx) {
      const propertyId = requireProperty(ctx);
      const bd = await getOrThrow(propertyId);
      const closed = bd.currentBusinessDate;
      bd.lastClosedDate = closed;
      bd.currentBusinessDate = nextDate(closed);
      bd.status = DATE_STATUS.OPEN;                 // new day opens
      bd.lastAuditAt = new Date().toISOString();
      bd.auditUserId = userOf(ctx);
      const saved = await repo.saveBusinessDate(bd);
      await emit('businessdate.changed', propertyId,
        { property_id: propertyId, closed_date: closed, business_date: saved.currentBusinessDate, status: saved.status }, ctx);
      return saved;
    },

    /** Rollback to a prior (re-opened) business date - tightly controlled. */
    async reopen(ctx, toDate) {
      const propertyId = requireProperty(ctx);
      const bd = await getOrThrow(propertyId);
      bd.currentBusinessDate = toDate;
      bd.status = DATE_STATUS.OPEN;
      const saved = await repo.saveBusinessDate(bd);
      await emit('businessdate.changed', propertyId, { property_id: propertyId, business_date: toDate, status: saved.status, reopened: true }, ctx);
      return saved;
    }
  };
}

module.exports = { buildBusinessDateEngine };
