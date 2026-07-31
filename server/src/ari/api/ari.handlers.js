'use strict';

/**
 * ARI management API handlers (Phase 52 D6; write paths tenant-transaction-
 * bound Phase 66A-B2N-A).
 *
 * buildAriHandlers({ ariService, ariStore, pool, withAriStore }) -> handler object.
 *
 * All handlers require tenant context (401 if absent); RBAC is enforced by route middleware.
 * All responses follow the envelope: { ok: true, data: ... } or { ok: false, error, message }.
 *
 * The store methods exposed by dbStore and memoryStore differ in naming conventions.
 * dbStore read methods:  roomTypes(pid), ratePlans(pid), inventory(pid, from, to), etc.
 * dbStore write methods: putRoomType, putRatePlan, putInventoryCell, adjustSold, etc.
 * memoryStore uses the same contract.
 *
 * PHASE 66A-B2N-A: read handlers below are UNCHANGED and still use the
 * injected `ariService`/`ariStore` singleton exactly as before — that
 * singleton was, and remains, bound to the boot-time bare pool. Fixing that
 * read-side gap would require changing ariService.js/ariAvailabilityProvider.js/
 * ariRateResolver.js, none of which are in this phase's authorized scope;
 * this preserves existing read behavior unchanged rather than silently
 * leaving it half-migrated.
 *
 * WRITE handlers (upsertRoomType, upsertRatePlan, upsertInventoryCell,
 * adjustSold, upsertRateRule, upsertRestrictionRule) now route through an
 * opaque `withAriStore(tenantId, callback)` — the SAME pattern
 * booking-engine/ariInventoryAdjuster.js uses — so every ARI write executes
 * inside one tenant-bound transaction instead of on the bare pool, and a
 * test can inject a fake `withAriStore` directly without needing a real
 * PostgreSQL pool. `withAriStore` defaults to the real
 * src/ari/store/tenantAriStore.js's withTenantAriStore curried with `pool`
 * when only `pool` is supplied (the production wiring path); an explicitly
 * injected `withAriStore` always takes precedence.
 */

const { withTenantAriStore } = require('../store/tenantAriStore');

function buildAriHandlers({ ariService, ariStore, pool, withAriStore } = {}) {
  const _withAriStore = withAriStore || (pool ? (tenantId, callback) => withTenantAriStore(pool, tenantId, callback) : null);
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
      if (!_withAriStore) return fail(res, 503, 'ari_not_configured');
      const rawBody = req.body || {};
      const body = Object.assign({}, rawBody, { tenant_id: tenantId, propertyId: propertyId || rawBody.propertyId });
      const row = await _withAriStore(tenantId, (store) => {
        const fn = store.putRoomType || store.upsertRoomType;
        if (typeof fn !== 'function') throw Object.assign(new Error('putRoomType not available'), { httpStatus: 501, httpError: 'method_not_supported' });
        return fn.call(store, body);
      });
      return ok(res, row);
    } catch (err) {
      if (err && err.httpStatus) return fail(res, err.httpStatus, err.httpError, err.message);
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
      if (!_withAriStore) return fail(res, 503, 'ari_not_configured');
      const rawBody = req.body || {};
      const body = Object.assign({}, rawBody, { tenant_id: tenantId, propertyId: propertyId || rawBody.propertyId });
      const row = await _withAriStore(tenantId, (store) => {
        const fn = store.putRatePlan || store.upsertRatePlan;
        if (typeof fn !== 'function') throw Object.assign(new Error('putRatePlan not available'), { httpStatus: 501, httpError: 'method_not_supported' });
        return fn.call(store, body);
      });
      return ok(res, row);
    } catch (err) {
      if (err && err.httpStatus) return fail(res, err.httpStatus, err.httpError, err.message);
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
      if (!_withAriStore) return fail(res, 503, 'ari_not_configured');
      const rawBody = req.body || {};
      const body = Object.assign({}, rawBody, { tenant_id: tenantId, propertyId: propertyId || rawBody.propertyId });
      const row = await _withAriStore(tenantId, (store) => {
        const fn = store.putInventoryCell || store.upsertInventoryCell;
        if (typeof fn !== 'function') throw Object.assign(new Error('putInventoryCell not available'), { httpStatus: 501, httpError: 'method_not_supported' });
        return fn.call(store, body);
      });
      return ok(res, row);
    } catch (err) {
      if (err && err.httpStatus) return fail(res, err.httpStatus, err.httpError, err.message);
      return fail(res, 500, 'upsert_inventory_cell_failed', err && err.message);
    }
  }

  async function adjustSold(req, res) {
    try {
      const { tenantId, propertyId } = tenantCtx(req);
      if (!tenantId) return fail(res, 401, 'tenant_required');
      if (!_withAriStore) return fail(res, 503, 'ari_not_configured');
      const body = req.body || {};
      const row = await _withAriStore(tenantId, (store) => store.adjustSold({
        tenant_id:  tenantId,
        propertyId: body.propertyId || propertyId,
        roomTypeId: body.roomTypeId || body.room_type_id,
        date:       body.date,
        delta:      Number(body.delta)
      }));
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
      if (!_withAriStore) return fail(res, 503, 'ari_not_configured');
      const rawBody = req.body || {};
      const body = Object.assign({}, rawBody, { tenant_id: tenantId, propertyId: propertyId || rawBody.propertyId });
      const row = await _withAriStore(tenantId, (store) => {
        const fn = store.putRateRule || store.upsertRateRule;
        if (typeof fn !== 'function') throw Object.assign(new Error('putRateRule not available'), { httpStatus: 501, httpError: 'method_not_supported' });
        return fn.call(store, body);
      });
      return ok(res, row);
    } catch (err) {
      if (err && err.httpStatus) return fail(res, err.httpStatus, err.httpError, err.message);
      return fail(res, 500, 'upsert_rate_rule_failed', err && err.message);
    }
  }

  // ---- Restriction Rules ----

  async function upsertRestrictionRule(req, res) {
    try {
      const { tenantId, propertyId } = tenantCtx(req);
      if (!tenantId) return fail(res, 401, 'tenant_required');
      if (!_withAriStore) return fail(res, 503, 'ari_not_configured');
      const rawBody = req.body || {};
      const body = Object.assign({}, rawBody, { tenant_id: tenantId, propertyId: propertyId || rawBody.propertyId });
      const row = await _withAriStore(tenantId, (store) => {
        const fn = store.putRestrictionRule || store.upsertRestrictionRule;
        if (typeof fn !== 'function') throw Object.assign(new Error('putRestrictionRule not available'), { httpStatus: 501, httpError: 'method_not_supported' });
        return fn.call(store, body);
      });
      return ok(res, row);
    } catch (err) {
      if (err && err.httpStatus) return fail(res, err.httpStatus, err.httpError, err.message);
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
