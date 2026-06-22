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

    let outcome;
    try {
      outcome = await cmd.handler(input, ctx);
    } catch (err) {
      return { ok: false, error: 'handler_threw', detail: String(err.message || err) };
    }
    if (!outcome || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
      return { ok: false, error: 'invalid_handler_outcome' };
    }

    // On success, publish any domain events the handler returned.
    if (outcome.ok && Array.isArray(outcome.events)) {
      for (const ev of outcome.events) {
        try { await eventBus.publish(ev); }
        catch (err) {
          logger.error({ err, event_type: ev && ev.event_type }, '[commandBus] event publish failed');
          // Outcome remains ok=true but log it - audit row already exists for command itself.
        }
      }
    }
    return outcome;
  });
}

function reset() {
  registry.clear();
}

module.exports = { register, unregister, dispatch, list, reset };
