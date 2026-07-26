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

  // Phase 64: a tenant-scoped query runs inside a tenant-bound READ ONLY
  // transaction, so its repository statements can actually see rows under
  // FORCE RLS — and PostgreSQL itself guarantees the "query" cannot mutate.
  let outcome;
  try {
    outcome = await runQueryScoped(q, input || {}, ctx);
  } catch (err) {
    if (err && typeof err.code === 'string' && err.code.startsWith('TENANT_')) {
      logger.error({ err, query: name, code: err.code }, '[queryBus] tenant unit of work failed');
      return { ok: false, error: 'tenant_context_failed', detail: err.code };
    }
    return { ok: false, error: 'handler_threw', detail: String(err.message || err) };
  }
  if (!outcome || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
    return { ok: false, error: 'invalid_handler_outcome' };
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Phase 64 — tenant-bound read unit of work
// ---------------------------------------------------------------------------

let _unitOfWork = null;
let _warnedNoUnitOfWork = false;

/** Install the tenant unit-of-work runner. Called once at boot (src/index.js). */
function setUnitOfWork(uow) {
  if (uow === null || uow === undefined) { _unitOfWork = null; return; }
  if (!uow.pool || typeof uow.runWithTenantRead !== 'function') {
    throw new Error('setUnitOfWork: { pool, runWithTenantRead } required');
  }
  _unitOfWork = uow;
  _warnedNoUnitOfWork = false;
}

function hasUnitOfWork() { return Boolean(_unitOfWork); }

async function runQueryScoped(q, input, ctx) {
  if (q.tenantScoped !== true) return q.handler(input, ctx);

  if (!_unitOfWork) {
    // Same fail-closed rule as the command bus: production must never read
    // tenant data through an unbound pooled connection.
    if (process.env.NODE_ENV === 'production') {
      logger.error({ query: q.name, code: 'tenant_unit_of_work_not_configured' },
        '[queryBus] REFUSING a tenant-scoped query: no tenant unit of work is configured');
      return { ok: false, error: 'tenant_unit_of_work_unavailable' };
    }
    if (!_warnedNoUnitOfWork) {
      _warnedNoUnitOfWork = true;
      logger.warn({ code: 'tenant_unit_of_work_not_configured' },
        '[queryBus] tenant-scoped queries are running WITHOUT a tenant-bound transaction. ' +
        'Valid only for in-memory tests.');
    }
    return q.handler(input, ctx);
  }

  return _unitOfWork.runWithTenantRead(_unitOfWork.pool, ctx.tenantId, () => q.handler(input, ctx));
}

function _summary(input) {
  if (input === null || input === undefined) return { _kind: typeof input };
  if (typeof input !== 'object') return { _kind: typeof input };
  return { _keys: Object.keys(input).slice(0, 32) };
}

function reset() {
  registry.clear();
  _unitOfWork = null;
  _warnedNoUnitOfWork = false;
}

module.exports = { register, unregister, list, execute, reset, setUnitOfWork, hasUnitOfWork };
