'use strict';

/**
 * Settings service.
 *
 * Resolution order (most-specific wins):
 *   1. settings row for the given (tenant_id, property_id, category, key)
 *   2. settings row for (tenant_id, NULL, category, key)    -- tenant-wide default
 *   3. caller-provided defaultValue
 *
 * No global cross-tenant defaults exist (per multi-tenant safety rule).
 *
 * API:
 *   get(category, key, opts) -> value | defaultValue
 *   set(category, key, valueJson, opts) -> { ok }    audited
 *   list(category, opts) -> [{ key, value_json, scope }]
 *   delete(category, key, opts) -> { ok }
 */

const { makeEvent } = require('../core/event');
const eventBus      = require('../core/eventBus');
const logger        = require('../config/logger');

/**
 * Settings catalog (Phase 6 / C14).
 *
 * The catalog is a process-wide registry of (category, key) -> spec.
 * Calls to `set()` are validated against the spec when one is registered.
 * Unknown keys are still accepted for backward compatibility, but a
 * `settings.unregistered_key` event is published so we can audit drift.
 *
 * Specs:
 *   value_type: 'boolean' | 'int' | 'number' | 'string' | 'json' | 'enum' | 'duration_seconds'
 *   enum_values: array of allowed values (only when value_type='enum')
 *   default_value: any
 *   description: string
 *   requires_permission: string  (advisory; surfaced in schema responses)
 */
const _catalog = new Map();   // key: 'category.key' -> spec

function _catKey(category, key) { return category + '.' + key; }

function registerSpec(category, key, spec) {
  if (!category || !key) throw new Error('register: category + key required');
  const types = ['boolean','int','number','string','json','enum','duration_seconds'];
  if (!spec || !types.includes(spec.value_type)) {
    throw new Error('register: value_type required (' + types.join('|') + ')');
  }
  if (spec.value_type === 'enum' && !Array.isArray(spec.enum_values)) {
    throw new Error('register: enum_values required for value_type=enum');
  }
  _catalog.set(_catKey(category, key), Object.assign({ category, key }, spec));
}

function _validateAgainstSpec(spec, value) {
  switch (spec.value_type) {
    case 'boolean':
      if (typeof value !== 'boolean') return 'setting_invalid_type';
      return null;
    case 'int':
      if (!Number.isInteger(value)) return 'setting_invalid_type';
      if (Number.isFinite(spec.min) && value < spec.min) return 'setting_below_min';
      if (Number.isFinite(spec.max) && value > spec.max) return 'setting_above_max';
      return null;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'setting_invalid_type';
      return null;
    case 'string':
      if (typeof value !== 'string') return 'setting_invalid_type';
      if (Number.isInteger(spec.max_len) && value.length > spec.max_len) return 'setting_too_long';
      return null;
    case 'json':
      if (value === null || typeof value !== 'object') return 'setting_invalid_type';
      return null;
    case 'enum':
      if (!spec.enum_values.includes(value)) return 'setting_invalid_enum';
      return null;
    case 'duration_seconds':
      if (!Number.isInteger(value) || value < 0) return 'setting_invalid_duration';
      return null;
    default:
      return null;
  }
}

function listCatalog(category) {
  const out = [];
  for (const spec of _catalog.values()) {
    if (!category || spec.category === category) out.push(spec);
  }
  return out.sort((a, b) =>
    a.category === b.category ? a.key.localeCompare(b.key) : a.category.localeCompare(b.category));
}

function lookupSpec(category, key) {
  return _catalog.get(_catKey(category, key)) || null;
}

function _resetCatalog() { _catalog.clear(); }

function buildSettings({ repo }) {
  if (!repo) throw new Error('buildSettings: repo required');

  async function get(category, key, opts = {}) {
    const ctx = opts.ctx;
    if (!ctx || !ctx.tenantId) throw new Error('settings.get: ctx.tenantId required');
    // Prefer property-scoped row, fall back to tenant-wide.
    if (ctx.propertyId) {
      const row = await repo.findSetting(ctx.tenantId, ctx.propertyId, category, key);
      if (row) return row.value_json;
    }
    const row = await repo.findSetting(ctx.tenantId, null, category, key);
    if (row) return row.value_json;
    return ('default' in opts) ? opts.default : null;
  }

  async function set(category, key, valueJson, opts = {}) {
    const ctx = opts.ctx;
    if (!ctx || !ctx.tenantId) return { ok: false, error: 'tenant_required' };

    // Phase 6 / C14: catalog validation if registered.
    const spec = lookupSpec(category, key);
    if (spec) {
      const err = _validateAgainstSpec(spec, valueJson);
      if (err) {
        try {
          await eventBus.publish(makeEvent({
            type: 'settings.set_rejected', aggregateType: 'setting',
            aggregateId: category + '.' + key,
            payload: { category, key, error: err, value_type: spec.value_type }, ctx
          }));
        } catch (_) {}
        return { ok: false, error: err };
      }
    } else {
      // Backward-compatible: emit a warning event so we can audit drift.
      try {
        await eventBus.publish(makeEvent({
          type: 'settings.unregistered_key', aggregateType: 'setting',
          aggregateId: category + '.' + key,
          payload: { category, key }, ctx
        }));
      } catch (_) {}
    }

    const scope = (opts.scope === 'property' && ctx.propertyId) ? 'property' : 'tenant';
    const propertyId = (scope === 'property') ? ctx.propertyId : null;
    await repo.upsertSetting({
      tenant_id:   ctx.tenantId,
      property_id: propertyId,
      category, key,
      value_json:  valueJson,
      updated_by:  ctx.actorId || null
    });
    try {
      await eventBus.publish(makeEvent({
        type:          'setting.updated',
        aggregateType: 'setting',
        aggregateId:   category + '.' + key + (propertyId ? '@' + propertyId : ''),
        payload: {
          category, key, scope,
          property_id: propertyId,
          actor_name:  ctx.actorName || null
        },
        ctx
      }));
    } catch (e) { logger.error({ err: e }, '[settings] audit publish failed'); }
    return { ok: true };
  }

  async function list(category, opts = {}) {
    const ctx = opts.ctx;
    if (!ctx || !ctx.tenantId) return [];
    return repo.listSettings(ctx.tenantId, category || null);
  }

  async function _delete(category, key, opts = {}) {
    const ctx = opts.ctx;
    if (!ctx || !ctx.tenantId) return { ok: false, error: 'tenant_required' };
    const scope = (opts.scope === 'property' && ctx.propertyId) ? 'property' : 'tenant';
    const propertyId = (scope === 'property') ? ctx.propertyId : null;
    const n = await repo.deleteSetting(ctx.tenantId, propertyId, category, key);
    if (n > 0) {
      try {
        await eventBus.publish(makeEvent({
          type:          'setting.deleted',
          aggregateType: 'setting',
          aggregateId:   category + '.' + key + (propertyId ? '@' + propertyId : ''),
          payload:       { category, key, scope, property_id: propertyId },
          ctx
        }));
      } catch (e) { logger.error({ err: e }, '[settings] audit publish failed'); }
    }
    return { ok: n > 0 };
  }

  return { get, set, list, delete: _delete,
           registerSpec, listCatalog, lookupSpec };
}

module.exports = { buildSettings,
                   registerSpec, listCatalog, lookupSpec, _resetCatalog };
