'use strict';

/**
 * ARI management API handlers (Phase 52 D6; write paths tenant-transaction-
 * bound Phase 66A-B2N-A).
 *
 * buildAriHandlers({ ariService, ariStore, pool, withAriUnit }) -> handler object.
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
 * adjustSold, upsertRateRule, upsertRestrictionRule) route through an opaque
 * `withAriUnit(tenantId, callback)` where the callback receives
 * `{ ariStore, outbox }` — BOTH built from the SAME tenant-bound transaction
 * client (Phase 66A-B2N-C1). That is what makes the authoritative mutation
 * and its ARI outbox event atomic: one transaction, commit together or roll
 * back together. A test can inject a fake `withAriUnit` directly without
 * needing a real PostgreSQL pool; it defaults to the real
 * src/ari/store/tenantAriStore.js's withTenantAriUnit curried with `pool`
 * (the production wiring path), and an explicitly injected `withAriUnit`
 * always takes precedence.
 *
 * Event mapping (B2N-C1): putRoomType -> AVAILABILITY_CHANGED,
 * putRatePlan -> RATE_CHANGED, putInventoryCell/adjustSold ->
 * INVENTORY_CHANGED. putRestrictionRule deliberately emits NOTHING — see the
 * B2N-C2 deferral note on that handler.
 */

const {
  withTenantAriUnit,
  ARI_CONFIG_EFFECTIVE_FROM,
  ARI_CONFIG_EFFECTIVE_TO
} = require('../store/tenantAriStore');

/** UTC-safe next calendar date for a 'YYYY-MM-DD' string (half-open [d, d+1)). */
function nextDate(date) {
  const t = Date.parse(String(date) + 'T00:00:00Z') + 86400000;
  const d = new Date(t);
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}

function buildAriHandlers({ ariService, ariStore, pool, withAriUnit } = {}) {
  const _withAriUnit = withAriUnit || (pool ? (tenantId, callback) => withTenantAriUnit(pool, tenantId, callback) : null);

  /**
   * B2N-C1: every emitting write needs a real property identity —
   * ari_outbox_store.property_id is NOT NULL and its composite FK binds
   * (tenant_id, property_id) to properties(tenant_id, id). Resolved from the
   * trusted request context first; a body value may only fill in when the
   * context carries none, and it can never cross a tenant boundary because
   * the outbox FK is evaluated inside the tenant-bound transaction. Returns
   * null when nothing usable is present, so the caller fails BEFORE mutating.
   */
  function resolveProperty(ctxPropertyId, rawBody) {
    const candidate = ctxPropertyId || (rawBody && rawBody.propertyId) || null;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
  }
  function propertyRequired() {
    return Object.assign(new Error('propertyId is required'), {
      httpStatus: 400, httpError: 'property_required'
    });
  }
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
      if (!_withAriUnit) return fail(res, 503, 'ari_not_configured');
      const rawBody = req.body || {};
      const property = resolveProperty(propertyId, rawBody);
      if (!property) throw propertyRequired();
      const body = Object.assign({}, rawBody, { tenant_id: tenantId, propertyId: property });
      const row = await _withAriUnit(tenantId, async ({ ariStore: store, outbox }) => {
        const fn = store.putRoomType || store.upsertRoomType;
        if (typeof fn !== 'function') throw Object.assign(new Error('putRoomType not available'), { httpStatus: 501, httpError: 'method_not_supported' });
        const saved = await fn.call(store, body);
        // A room type is undated configuration: total_units changes what can
        // be sold on every date, so it emits AVAILABILITY_CHANGED over the
        // fixed sentinel window.
        await outbox.enqueue({
          tenantId,
          propertyId:    property,
          eventType:     'AVAILABILITY_CHANGED',
          resourceKind:  'AVAILABILITY',
          roomTypeId:    saved.roomTypeId,
          ratePlanId:    null,
          effectiveFrom: ARI_CONFIG_EFFECTIVE_FROM,
          effectiveTo:   ARI_CONFIG_EFFECTIVE_TO,
          sourceVersion: saved.version,
          payload: { code: saved.code, name: saved.name, totalUnits: saved.totalUnits }
        });
        return saved;
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
      if (!_withAriUnit) return fail(res, 503, 'ari_not_configured');
      const rawBody = req.body || {};
      const property = resolveProperty(propertyId, rawBody);
      if (!property) throw propertyRequired();
      const body = Object.assign({}, rawBody, { tenant_id: tenantId, propertyId: property });
      const row = await _withAriUnit(tenantId, async ({ ariStore: store, outbox }) => {
        const fn = store.putRatePlan || store.upsertRatePlan;
        if (typeof fn !== 'function') throw Object.assign(new Error('putRatePlan not available'), { httpStatus: 501, httpError: 'method_not_supported' });
        const saved = await fn.call(store, body);
        // Undated rate configuration → RATE_CHANGED over the sentinel window.
        // This is the ONLY mutation that may carry a rate_plan_id (migration
        // 0087's ari_outbox_store_rate_plan_compat CHECK).
        await outbox.enqueue({
          tenantId,
          propertyId:    property,
          eventType:     'RATE_CHANGED',
          resourceKind:  'RATE',
          roomTypeId:    saved.roomTypeId,
          ratePlanId:    saved.ratePlanId,
          effectiveFrom: ARI_CONFIG_EFFECTIVE_FROM,
          effectiveTo:   ARI_CONFIG_EFFECTIVE_TO,
          sourceVersion: saved.version,
          payload: { code: saved.code, currency: saved.currency, baseRate: saved.baseRate }
        });
        return saved;
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
      if (!_withAriUnit) return fail(res, 503, 'ari_not_configured');
      const rawBody = req.body || {};
      const property = resolveProperty(propertyId, rawBody);
      if (!property) throw propertyRequired();
      const body = Object.assign({}, rawBody, { tenant_id: tenantId, propertyId: property });
      const row = await _withAriUnit(tenantId, async ({ ariStore: store, outbox }) => {
        const fn = store.putInventoryCell || store.upsertInventoryCell;
        if (typeof fn !== 'function') throw Object.assign(new Error('putInventoryCell not available'), { httpStatus: 501, httpError: 'method_not_supported' });
        const saved = await fn.call(store, body);
        // Exactly ONE INVENTORY_CHANGED event, even when blocked/stopSell
        // changed too — a consumer re-reads the cell, so a second
        // AVAILABILITY_CHANGED would carry no extra information.
        await outbox.enqueue({
          tenantId,
          propertyId:    property,
          eventType:     'INVENTORY_CHANGED',
          resourceKind:  'INVENTORY',
          roomTypeId:    saved.roomTypeId,
          ratePlanId:    null,
          effectiveFrom: saved.date,
          effectiveTo:   nextDate(saved.date),
          sourceVersion: saved.version,
          payload: {
            date: saved.date, physical: saved.physical, sold: saved.sold,
            blocked: saved.blocked, overbookingBuffer: saved.overbookingBuffer,
            stopSell: saved.stopSell
          }
        });
        return saved;
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
      if (!_withAriUnit) return fail(res, 503, 'ari_not_configured');
      const body = req.body || {};
      const property = resolveProperty(propertyId, body);
      if (!property) throw propertyRequired();
      const roomTypeId = body.roomTypeId || body.room_type_id;
      const date = body.date;
      const delta = Number(body.delta);
      const row = await _withAriUnit(tenantId, async ({ ariStore: store, outbox }) => {
        const changed = await store.adjustSold({
          tenant_id:  tenantId,
          propertyId: property,
          roomTypeId,
          date,
          delta
        });
        // A floor/ceiling guard result is a successful zero-row UPDATE:
        // nothing changed, so nothing is announced.
        if (changed === null) return null;
        await outbox.enqueue({
          tenantId,
          propertyId:    property,
          eventType:     'INVENTORY_CHANGED',
          resourceKind:  'INVENTORY',
          roomTypeId,
          ratePlanId:    null,
          effectiveFrom: date,
          effectiveTo:   nextDate(date),
          sourceVersion: changed.version,
          payload: { date, delta, sold: changed.sold, source: 'ari_api' }
        });
        return changed;
      });
      if (row === null) return ok(res, { adjusted: false, reason: 'floor_guard' });
      return ok(res, { adjusted: true, row });
    } catch (err) {
      if (err && err.httpStatus) return fail(res, err.httpStatus, err.httpError, err.message);
      return fail(res, 500, 'adjust_sold_failed', err && err.message);
    }
  }

  // ---- Rate Rules ----

  async function upsertRateRule(req, res) {
    try {
      const { tenantId, propertyId } = tenantCtx(req);
      if (!tenantId) return fail(res, 401, 'tenant_required');
      if (!_withAriUnit) return fail(res, 503, 'ari_not_configured');
      const rawBody = req.body || {};
      const body = Object.assign({}, rawBody, { tenant_id: tenantId, propertyId: propertyId || rawBody.propertyId });
      // No ari_rate_rule writer exists in dbStore.js (carried forward from the
      // B2N discovery) — this path still returns 501 and therefore never
      // reaches an enqueue.
      const row = await _withAriUnit(tenantId, ({ ariStore: store }) => {
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

  /**
   * PHASE 66A-B2N-C2 DEFERRAL — restriction-rule outbox event production is
   * DELIBERATELY NOT IMPLEMENTED here.
   *
   * ari_restriction_rule.room_type_id and rate_plan_id are both NULLABLE (a
   * property-level or channel-level rule scopes neither), but the canonical
   * outbox identity requires a non-empty roomTypeId
   * (ari_outbox_store_room_type_nonempty), and roomTypeId participates in the
   * dedupe key. Emitting would require inventing a placeholder roomTypeId, a
   * synthetic date, a derived version or a rule hash — every one of which is
   * a collision-prone workaround this phase explicitly forbids.
   *
   * The authoritative mutation below still runs, and now returns its
   * database-assigned version additively (B2N-C1 decision B2), so B2N-C2 can
   * design a safe restriction-event identity on top of it. Restriction event
   * production, full B2N-C and P0-12 all remain OPEN.
   */
  async function upsertRestrictionRule(req, res) {
    try {
      const { tenantId, propertyId } = tenantCtx(req);
      if (!tenantId) return fail(res, 401, 'tenant_required');
      if (!_withAriUnit) return fail(res, 503, 'ari_not_configured');
      const rawBody = req.body || {};
      const body = Object.assign({}, rawBody, { tenant_id: tenantId, propertyId: propertyId || rawBody.propertyId });
      const row = await _withAriUnit(tenantId, ({ ariStore: store }) => {
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
