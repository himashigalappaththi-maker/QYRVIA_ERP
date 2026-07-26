'use strict';

/**
 * Command bus - the only way to mutate state.
 *
 * Phase 1: registry is empty. dispatch() returns
 *   { ok:false, error:'command_not_registered' }
 * for every call - but it still routes through the audit pipeline so the
 * attempt and the denial are recorded.
 *
 * Command record shape (see commands/_template.js):
 *   {
 *     name:           '<aggregate>.<verb>',
 *     aggregateType:  '<aggregate>',
 *     inputSchema:    {...},                 // schema reference (future)
 *     handler: async (input, ctx) => ({      // returned shape:
 *       ok: boolean,
 *       result?: any,
 *       events?: DomainEvent[],              // events to publish on success
 *       error?: string,                      // machine code on failure
 *       detail?: string                      // human detail on failure
 *     })
 *   }
 */

const eventBus      = require('./eventBus');
const { runWithAudit } = require('../audit/pipeline');
const logger        = require('../config/logger');

const registry = new Map();

// Phase 63 P1-1: optional sink for domain-event persistence failures, wired at
// boot to metrics/alerting. Kept as an injected hook (not a direct require of
// the observability module) so core/ stays free of boot-order dependencies.
let _onEventPersistenceFailure = null;

/** @param {null | (info: {command: string, failures: object[], ctx: object}) => void} fn */
function setEventPersistenceFailureHook(fn) {
  _onEventPersistenceFailure = typeof fn === 'function' ? fn : null;
}

// ---------------------------------------------------------------------------
// Phase 64 — tenant-bound unit of work (P0-11, P1-5, P1-6, P1-8)
// ---------------------------------------------------------------------------
//
// A command flagged `tenantScoped: true` runs inside ONE tenant-bound
// transaction: exactly one pooled client, `app.tenant_id` bound with
// transaction-LOCAL scope, and every repository statement in the handler
// sharing it. That is what makes the PMS write chain both RLS-visible and
// atomic — before this, each statement ran on its own pooled connection with no
// tenant bound and nothing to roll back.
//
// The runner is INJECTED (see setUnitOfWork, wired in src/index.js) so core/
// never has to require db/ and inherit its boot order.

let _unitOfWork = null;      // { pool, runWithTenantTransaction, runWithTenantRead }
let _warnedNoUnitOfWork = false;

/**
 * Install the tenant unit-of-work runner. Called once at boot.
 * @param {null | {pool: object, runWithTenantTransaction: Function, runWithTenantRead: Function}} uow
 */
function setUnitOfWork(uow) {
  if (uow === null || uow === undefined) { _unitOfWork = null; return; }
  if (!uow.pool || typeof uow.runWithTenantTransaction !== 'function'
      || typeof uow.runWithTenantRead !== 'function') {
    throw new Error('setUnitOfWork: { pool, runWithTenantTransaction, runWithTenantRead } required');
  }
  _unitOfWork = uow;
  _warnedNoUnitOfWork = false;
}

function hasUnitOfWork() { return Boolean(_unitOfWork); }

/**
 * Marker used to force a ROLLBACK when a handler REJECTS a command.
 *
 * Handlers signal rejection by returning { ok:false }, not by throwing. Left
 * alone, the unit of work would see a normal return and COMMIT — persisting
 * whatever the handler wrote before it decided to reject. A rejected command
 * must leave nothing behind, so the rejection is thrown across the transaction
 * boundary and unwrapped on the other side.
 */
class CommandRejected extends Error {
  constructor(outcome) { super('command_rejected'); this.outcome = outcome; }
}

function normaliseOutcome(o) {
  if (!o || typeof o !== 'object' || typeof o.ok !== 'boolean') {
    return { ok: false, error: 'invalid_handler_outcome' };
  }
  return o;
}

async function runHandlerScoped(cmd, input, ctx) {
  const tenantScoped = cmd.tenantScoped === true;

  if (!tenantScoped) {
    try {
      return normaliseOutcome(await cmd.handler(input, ctx));
    } catch (err) {
      return { ok: false, error: 'handler_threw', detail: String(err.message || err) };
    }
  }

  if (!_unitOfWork) {
    // FAIL CLOSED in production: a tenant-scoped command that runs without a
    // bound transaction is exactly the P0-11 defect. Outside production the
    // handler still runs (unit tests inject in-memory repositories that have no
    // pool and no RLS), but the gap is announced loudly and once.
    if (process.env.NODE_ENV === 'production') {
      logger.error({ command: cmd.name, code: 'tenant_unit_of_work_not_configured' },
        '[commandBus] REFUSING a tenant-scoped command: no tenant unit of work is configured');
      return { ok: false, error: 'tenant_unit_of_work_unavailable' };
    }
    if (!_warnedNoUnitOfWork) {
      _warnedNoUnitOfWork = true;
      logger.warn({ code: 'tenant_unit_of_work_not_configured' },
        '[commandBus] tenant-scoped commands are running WITHOUT a tenant-bound transaction ' +
        '(no unit of work configured). Valid only for in-memory tests.');
    }
    try {
      return normaliseOutcome(await cmd.handler(input, ctx));
    } catch (err) {
      return { ok: false, error: 'handler_threw', detail: String(err.message || err) };
    }
  }

  const runner = cmd.transactionMode === 'read'
    ? _unitOfWork.runWithTenantRead
    : _unitOfWork.runWithTenantTransaction;

  try {
    return await runner(_unitOfWork.pool, ctx.tenantId, async () => {
      const outcome = normaliseOutcome(await cmd.handler(input, ctx));
      if (!outcome.ok) throw new CommandRejected(outcome);
      return outcome;
    });
  } catch (err) {
    if (err instanceof CommandRejected) return err.outcome;   // rolled back cleanly
    if (err && typeof err.code === 'string' && err.code.startsWith('TENANT_')) {
      logger.error({ err, command: cmd.name, code: err.code },
        '[commandBus] tenant unit of work failed');
      return { ok: false, error: 'tenant_context_failed', detail: err.code };
    }
    return { ok: false, error: 'handler_threw', detail: String(err.message || err) };
  }
}

function register(command) {
  if (!command || typeof command !== 'object') throw new Error('register: command must be an object');
  if (!command.name)    throw new Error('register: command.name is required');
  if (!command.handler) throw new Error('register: command.handler is required');
  if (registry.has(command.name)) throw new Error('register: command already registered: ' + command.name);
  registry.set(command.name, command);
  logger.debug({ command: command.name }, '[commandBus] registered');
}

function unregister(name) {
  registry.delete(name);
}

function list() {
  return Array.from(registry.keys()).sort();
}

/**
 * Dispatch a command. Always routes through the audit pipeline.
 *
 * @param {string} name   - command name, e.g. 'reservation.create'
 * @param {object} input  - command input payload
 * @param {object} ctx    - request context { tenantId, propertyId, requestId, actorId }
 * @returns {Promise<{ok, result?, error?, detail?}>}
 */
async function dispatch(name, input, ctx) {
  if (!ctx || !ctx.tenantId)   return { ok: false, error: 'tenant_required' };
  if (!ctx.requestId)          return { ok: false, error: 'request_id_required' };

  const cmd = registry.get(name) || { name, aggregateType: 'command' };

  return runWithAudit(cmd, input, ctx, async () => {
    if (!registry.has(name)) return { ok: false, error: 'command_not_registered' };

    // Phase 2: enforce per-command permission. super_admin bypass.
    if (cmd.permission) {
      const roles = ctx.roleCodes || [];
      const perms = ctx.permissions || [];
      const isSuper = roles.includes('super_admin');
      if (!isSuper && !perms.includes(cmd.permission)) {
        return { ok: false, error: 'permission_denied', detail: 'required: ' + cmd.permission };
      }
    }

    // Phase 5.5: accounting-sensitive commands are blocked when the property's
    // business date is locked (mid-night-audit). The night audit command
    // itself is exempt - it OWNS the lock - and bypasses by being the only
    // command flagged `acceptsBusinessDateLocked: true`.
    if (cmd.accountingSensitive === true
        && ctx.businessDateLocked === true
        && cmd.acceptsBusinessDateLocked !== true) {
      return { ok: false, error: 'business_date_locked',
               detail: 'Accounting-sensitive command rejected while night audit is in progress.' };
    }

    // Phase 64: a tenant-scoped command runs inside ONE tenant-bound
    // transaction. See runHandlerScoped for why a handler returning ok:false
    // must roll the transaction back rather than commit it.
    const outcome = await runHandlerScoped(cmd, input, ctx);
    if (!outcome.ok) return outcome;

    // On success, publish any domain events the handler returned.
    //
    // Phase 64 ORDERING: this runs AFTER runHandlerScoped has returned, so for a
    // tenant-scoped command the transaction has already COMMITTED. A rolled-back
    // command therefore publishes nothing — it returns above on !outcome.ok and
    // never reaches this block. Announcing a reservation that a rollback erased
    // would be worse than losing the announcement: subscribers act on it.
    //
    // Phase 63 P1-1: a publish failure means the canonical domain-event stream
    // has a HOLE while the state change is already committed. The outcome stays
    // ok=true (the write really did happen — reporting failure would be a lie
    // and would invite an unsafe client retry), but the degradation is no
    // longer silent: it is logged with a stable machine code, surfaced through
    // the injected failure hook (wired to metrics/alerting at boot), and
    // attached to the outcome as a NON-ENUMERABLE marker so downstream code can
    // detect it without changing the serialised command response shape.
    if (outcome.ok && Array.isArray(outcome.events)) {
      const failures = [];
      for (const ev of outcome.events) {
        try { await eventBus.publish(ev); }
        catch (err) {
          failures.push({ event_type: (ev && ev.event_type) || null, error: String(err && err.message || err) });
          logger.error(
            { err, code: 'event_persistence_failed', command: name, event_type: ev && ev.event_type },
            '[commandBus] event publish failed - domain event stream is INCOMPLETE');
        }
      }
      if (failures.length > 0) {
        if (_onEventPersistenceFailure) {
          try { _onEventPersistenceFailure({ command: name, failures, ctx }); }
          catch (hookErr) { logger.error({ err: hookErr }, '[commandBus] event persistence hook threw'); }
        }
        try {
          Object.defineProperty(outcome, 'eventPersistenceFailures', {
            value: failures, enumerable: false, configurable: true, writable: false
          });
        } catch (_) { /* frozen outcome - the log + hook are already emitted */ }
      }
    }
    return outcome;
  });
}

function reset() {
  registry.clear();
  _onEventPersistenceFailure = null;
  _unitOfWork = null;
  _warnedNoUnitOfWork = false;
}

module.exports = {
  register, unregister, dispatch, list, reset,
  setEventPersistenceFailureHook,
  setUnitOfWork, hasUnitOfWork
};
