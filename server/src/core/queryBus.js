'use strict';

/**
 * Query bus - the only way to READ data (strict CQRS separation from
 * commandBus which is the only way to WRITE).
 *
 * Query record shape:
 *   {
 *     name:          'reservation.list',
 *     resourceType:  'reservation',
 *     permission:    'reservation.read'   (optional - if absent, public to authenticated callers)
 *     audited:       false                 (optional - if true, write query.run audit row)
 *     handler: async (input, ctx) => ({ ok:true, data, total? }) | { ok:false, error }
 *   }
 *
 * dispatch:
 *   const r = await queryBus.execute('reservation.list', { page:1, size:25 }, ctx);
 *
 * Returns the handler outcome verbatim. On auth/permission failure returns:
 *   { ok:false, error:'permission_denied' | 'query_not_registered' | 'tenant_required' }
 *
 * Queries MUST NOT mutate. The bus does not run them through the audit
 * pipeline by default (audit_events would explode). Set audited:true for
 * high-sensitivity queries that need an audit trail.
 */

const eventBus      = require('./eventBus');
const { makeEvent } = require('./event');
const logger        = require('../config/logger');

const registry = new Map();

function register(query) {
  if (!query || typeof query !== 'object') throw new Error('register: query must be an object');
  if (!query.name)    throw new Error('register: query.name is required');
  if (!query.handler) throw new Error('register: query.handler is required');
  if (registry.has(query.name)) throw new Error('register: query already registered: ' + query.name);
  registry.set(query.name, query);
  logger.debug({ query: query.name }, '[queryBus] registered');
}

function unregister(name) { registry.delete(name); }
function list() { return Array.from(registry.keys()).sort(); }

async function execute(name, input, ctx) {
  if (!ctx || !ctx.tenantId)  return { ok: false, error: 'tenant_required' };
  if (!ctx.requestId)         return { ok: false, error: 'request_id_required' };

  const q = registry.get(name);
  if (!q) return { ok: false, error: 'query_not_registered' };

  // Permission check (queries opt in via query.permission)
  if (q.permission) {
    const roles = ctx.roleCodes  || [];
    const perms = ctx.permissions || [];
    const isSuper = roles.includes('super_admin');
    if (!isSuper && !perms.includes(q.permission)) {
      return { ok: false, error: 'permission_denied', detail: 'required: ' + q.permission };
    }
  }

  // Audit-only-if-opted-in (queries are read-only)
  if (q.audited) {
    try {
      await eventBus.publish(makeEvent({
        type:          'query.run',
        aggregateType: q.resourceType || 'query',
        aggregateId:   name,
        payload: {
          query_name:    name,
          actor_name:    ctx.actorName || null,
          input_summary: _summary(input)
        },
        ctx
      }));
    } catch (err) {
      logger.error({ err, query: name }, '[queryBus] audit publish failed');
      // do not fail the read on audit failure; log and continue
    }
  }

  let outcome;
  try {
    outcome = await q.handler(input || {}, ctx);
  } catch (err) {
    return { ok: false, error: 'handler_threw', detail: String(err.message || err) };
  }
  if (!outcome || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
    return { ok: false, error: 'invalid_handler_outcome' };
  }
  return outcome;
}

function _summary(input) {
  if (input === null || input === undefined) return { _kind: typeof input };
  if (typeof input !== 'object') return { _kind: typeof input };
  return { _keys: Object.keys(input).slice(0, 32) };
}

function reset() { registry.clear(); }

module.exports = { register, unregister, list, execute, reset };
