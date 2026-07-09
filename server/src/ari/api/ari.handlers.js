'use strict';

/**
 * ARI management API handlers (Phase 52 D6).
 *
 * buildAriHandlers({ ariService, ariStore }) -> handler object.
 *
 * All handlers require tenant context (401 if absent); RBAC is enforced by route middleware.
 * All responses follow the envelope: { ok: true, data: ... } or { ok: false, error, message }.
 *
 * The store methods exposed by dbStore and memoryStore differ in naming conventions.
 * dbStore read methods:  roomTypes(pid), ratePlans(pid), inventory(pid, from, to), etc.
 * dbStore write methods: putRoomType, putRatePlan, putInventoryCell, adjustSold, etc.
 * memoryStore uses the same contract.
 */

function buildAriHandlers({ ariService, ariStore } = {}) {
  function ok(res, data) {
    return res.status(200).json({ ok: true, data });
  }
  function fail(res, status, error, message) {
    return res.status(status).json({ ok: false, error, message: message || error });
  }
  function tenantCtx(req) {
    const ctx = req.ctx || {};
    return { tenantId: ctx.tenantId || null, propertyId: ctx.propertyId || null };
  }

  // ---- Room Types ----

  async function listRoomTypes(req, res) {
    try {
      const { tenantId, propertyId } = tenantCtx(req);
      if (!tenantId) return fail(res, 401, 'tenant_required');
      if (!ariStore) return ok(res, []);
      const rows = typeof ariStore.roomTypes === 'function'
        ? await ariStore.roomTypes(propertyId)
        : [];
      return ok(res, rows);
    } catch (err) {
      return fail(res, 500, 'list_room_types_failed', err && err.message);
    }
  }

  async function upsertRoomType(req, res) {
    try {
      const { tenantId, propertyId } = tenantCtx(req);
      if (!tenantId) return fail(res, 401, 'tenant_required');
      if (!ariStore) return fail(res, 503, 'ari_not_configured');
      const rawBody = req.body || {};
      const body = Object.assign({}, rawBody, { tenant_id: tenantId, propertyId: propertyId || rawBody.propertyId });
      const fn = ariStore.putRoomType || ariStore.upsertRoomType;
      if (typeof fn !== 'function') return fail(res, 501, 'method_not_supported', 'putRoomType not available');
      const row = await fn.call(ariStore, body);
      return ok(res, row);
    } catch (err) {
      return fail(res, 500, 'upsert_room_type_failed', err && err.message);
    }
  }

  // ---- Rate Plans ----

  async function listRatePlans(req, res) {
    try {
      const { tenantId, propertyId } = tenantCtx(req);
      if (!tenantId) return fail(res, 401, 'tenant_required');
      if (!ariStore) return ok(res, []);
      const rows = typeof ariStore.ratePlans === 'function'
        ? await ariStore.ratePlans(propertyId)
        : [];
      return ok(res, rows);
    } catch (err) {
      return fail(res, 500, 'list_rate_plans_failed', err && err.message);
    }
  }

  async function upsertRatePlan(req, res) {
    try {
      const { tenantId, propertyId } = tenantCtx(req);
      if (!tenantId) return fail(res, 401, 'tenant_required');
      if (!ariStore) return fail(res, 503, 'ari_not_configured');
      const rawBody = req.body || {};
      const body = Object.assign({}, rawBody, { tenant_id: tenantId, propertyId: propertyId || rawBody.propertyId });
      const fn = ariStore.putRatePlan || ariStore.upsertRatePlan;
      if (typeof fn !== 'function') return fail(res, 501, 'method_not_supported', 'putRatePlan not available');
      const row = await fn.call(ariStore, body);
      return ok(res, row);
    } catch (err) {
      return fail(res, 500, 'upsert_rate_plan_failed', err && err.message);
    }
  }

  // ---- Inventory ----

  async function getInventory(req, res) {
    try {
      const { tenantId, propertyId } = tenantCtx(req);
      if (!tenantId) return fail(res, 401, 'tenant_required');
      if (!ariStore) return ok(res, []);
      const q = req.query || {};
      const roomTypeId = q.room_type_id || null;
      const dateFrom   = q.date_from    || null;
      const dateTo     = q.date_to      || null;
      // Use inventory(pid, from, to) — the standard store read method
      const rows = typeof ariStore.inventory === 'function'
        ? await ariStore.inventory(propertyId, dateFrom, dateTo)
        : [];
      // Optionally filter by roomTypeId client-side (store already scopes by property)
      const filtered = roomTypeId ? rows.filter((r) => r.roomTypeId === roomTypeId) : rows;
      return ok(res, filtered);
    } catch (err) {
      return fail(res, 500, 'get_inventory_failed', err && err.message);
    }
  }

  async function upsertInventoryCell(req, res) {
    try {
      const { tenantId, propertyId } = tenantCtx(req);
      if (!tenantId) return fail(res, 401, 'tenant_required');
      if (!ariStore) return fail(res, 503, 'ari_not_configured');
      const rawBody = req.body || {};
      const body = Object.assign({}, rawBody, { tenant_id: tenantId, propertyId: propertyId || rawBody.propertyId });
      const fn = ariStore.putInventoryCell || ariStore.upsertInventoryCell;
      if (typeof fn !== 'function') return fail(res, 501, 'method_not_supported', 'putInventoryCell not available');
      const row = await fn.call(ariStore, body);
      return ok(res, row);
    } catch (err) {
      return fail(res, 500, 'upsert_inventory_cell_failed', err && err.message);
    }
  }

  async function adjustSold(req, res) {
    try {
      const { tenantId, propertyId } = tenantCtx(req);
      if (!tenantId) return fail(res, 401, 'tenant_required');
      if (!ariStore) return fail(res, 503, 'ari_not_configured');
      const body = req.body || {};
      const row = await ariStore.adjustSold({
        tenant_id:  body.tenant_id || tenantId,
        propertyId: body.propertyId || propertyId,
        roomTypeId: body.roomTypeId || body.room_type_id,
        date:       body.date,
        delta:      Number(body.delta)
      });
      if (row === null) return ok(res, { adjusted: false, reason: 'floor_guard' });
      return ok(res, { adjusted: true, row });
    } catch (err) {
      return fail(res, 500, 'adjust_sold_failed', err && err.message);
    }
  }

  // ---- Rate Rules ----

  async function upsertRateRule(req, res) {
    try {
      const { tenantId, propertyId } = tenantCtx(req);
      if (!tenantId) return fail(res, 401, 'tenant_required');
      if (!ariStore) return fail(res, 503, 'ari_not_configured');
      const rawBody = req.body || {};
      const body = Object.assign({}, rawBody, { tenant_id: tenantId, propertyId: propertyId || rawBody.propertyId });
      const fn = ariStore.putRateRule || ariStore.upsertRateRule;
      if (typeof fn !== 'function') return fail(res, 501, 'method_not_supported', 'putRateRule not available');
      const row = await fn.call(ariStore, body);
      return ok(res, row);
    } catch (err) {
      return fail(res, 500, 'upsert_rate_rule_failed', err && err.message);
    }
  }

  // ---- Restriction Rules ----

  async function upsertRestrictionRule(req, res) {
    try {
      const { tenantId, propertyId } = tenantCtx(req);
      if (!tenantId) return fail(res, 401, 'tenant_required');
      if (!ariStore) return fail(res, 503, 'ari_not_configured');
      const rawBody = req.body || {};
      const body = Object.assign({}, rawBody, { tenant_id: tenantId, propertyId: propertyId || rawBody.propertyId });
      const fn = ariStore.putRestrictionRule || ariStore.upsertRestrictionRule;
      if (typeof fn !== 'function') return fail(res, 501, 'method_not_supported', 'putRestrictionRule not available');
      const row = await fn.call(ariStore, body);
      return ok(res, row);
    } catch (err) {
      return fail(res, 500, 'upsert_restriction_rule_failed', err && err.message);
    }
  }

  // ---- ARI compute + quote ----

  async function computeAri(req, res) {
    try {
      const { tenantId, propertyId } = tenantCtx(req);
      if (!tenantId) return fail(res, 401, 'tenant_required');
      if (!ariService) return ok(res, { bookable: false, reason: 'ari_not_configured' });
      const q = req.query || {};
      const result = await ariService.computeAri({
        tenantId,
        propertyId: q.property_id || propertyId,
        dateFrom:   q.date_from   || null,
        dateTo:     q.date_to     || null,
        channel:    q.channel     || null
      });
      return ok(res, result);
    } catch (err) {
      return fail(res, 500, 'compute_ari_failed', err && err.message);
    }
  }

  async function quoteStay(req, res) {
    try {
      const { tenantId, propertyId } = tenantCtx(req);
      if (!tenantId) return fail(res, 401, 'tenant_required');
      if (!ariService) return ok(res, { bookable: false, reason: 'ari_not_configured' });
      const q = req.query || {};
      const result = await ariService.quoteStay({
        tenantId,
        propertyId:  q.property_id   || propertyId,
        roomTypeId:  q.room_type_id   || null,
        ratePlanId:  q.rate_plan_id   || null,
        arrival:     q.arrival        || null,
        departure:   q.departure      || null,
        adults:      q.adults ? Number(q.adults) : undefined,
        channel:     q.channel        || null
      });
      return ok(res, result);
    } catch (err) {
      return fail(res, 500, 'quote_stay_failed', err && err.message);
    }
  }

  return {
    listRoomTypes,
    upsertRoomType,
    listRatePlans,
    upsertRatePlan,
    getInventory,
    upsertInventoryCell,
    adjustSold,
    upsertRateRule,
    upsertRestrictionRule,
    computeAri,
    quoteStay
  };
}

module.exports = { buildAriHandlers };
