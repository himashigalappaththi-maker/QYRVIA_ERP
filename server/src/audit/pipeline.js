'use strict';

/**
 * AUDIT PIPELINE - mandatory hook every command flows through.
 *
 * Wraps a command handler so that:
 *   1. Before the handler runs, a `command.attempted` event is published.
 *   2. After the handler returns, a `command.{succeeded|failed|denied}` event
 *      is published describing the outcome.
 *
 * Both events land in `audit_events` via the eventBus persistent subscriber.
 * No code path bypasses this pipeline because the commandBus is the only way
 * to invoke a command, and it always wraps via `runWithAudit`.
 */

const crypto = require('crypto');
const { makeEvent } = require('../core/event');
const eventBus      = require('../core/eventBus');
const logger        = require('../config/logger');

/**
 * Run a command handler under the audit pipeline.
 *
 * @param {object} cmd      - the command record { name, aggregateType }
 * @param {object} input    - the command input payload
 * @param {object} ctx      - request context { tenantId, propertyId, requestId, actorId }
 * @param {Function} runHandler - async function returning
 *   { ok, result?, events?, error?, entityType?, entityId? }. entityType/entityId
 *   are optional and, when present, are copied onto the succeeded/failed/denied
 *   audit event's payload (entity_type/entity_id) — existing callers that don't
 *   set them are unaffected (fields are simply null).
 * @returns {Promise<object>} the runHandler outcome, unchanged
 */
async function runWithAudit(cmd, input, ctx, runHandler) {
  const commandId = crypto.randomUUID();

  // --- 1. attempt ---------------------------------------------------------
  try {
    await eventBus.publish(makeEvent({
      type:          'command.attempted',
      aggregateType: cmd.aggregateType || 'command',
      aggregateId:   commandId,
      ctx,
      payload: {
        command_id:    commandId,
        command_name:  cmd.name,
        actor_name:    ctx.actorName || null,
        input_summary: _summary(input)
      }
    }));
  } catch (err) {
    // If we cannot record the attempt, refuse the command - audit integrity
    // outranks availability for write paths.
    logger.error({ err, command: cmd.name }, '[audit] failed to record attempt');
    return { ok: false, error: 'audit_attempt_failed' };
  }

  // --- 2. run -------------------------------------------------------------
  let outcome;
  try {
    outcome = await runHandler();
  } catch (err) {
    outcome = { ok: false, error: 'handler_threw', detail: String(err.message || err) };
  }

  // --- 3. record result ---------------------------------------------------
  const status = outcome.ok ? 'succeeded' : (outcome.error === 'permission_denied' ? 'denied' : 'failed');
  try {
    await eventBus.publish(makeEvent({
      type:          'command.' + status,
      aggregateType: cmd.aggregateType || 'command',
      aggregateId:   commandId,
      ctx,
      payload: {
        command_id:   commandId,
        command_name: cmd.name,
        actor_name:   ctx.actorName || null,
        error:        outcome.error || null,
        detail:       outcome.detail || null,
        entity_type:  outcome.entityType || null,
        entity_id:    outcome.entityId || null
      }
    }));
  } catch (err) {
    // Result audit must not silently fail - log loud but return the outcome
    // (the user-facing operation already happened).
    logger.error({ err, command: cmd.name, status }, '[audit] failed to record result');
  }

  return outcome;
}

/**
 * Summarize an input object for audit. Avoid logging full payloads (they may
 * contain sensitive data or be huge). Phase 1 = top-level key list + sizes.
 */
function _summary(input) {
  if (input === null || input === undefined) return { _kind: typeof input };
  if (typeof input !== 'object') return { _kind: typeof input };
  const keys = Object.keys(input).slice(0, 32);
  const out  = { _keys: keys };
  if (Array.isArray(input)) out._length = input.length;
  return out;
}

module.exports = { runWithAudit };
