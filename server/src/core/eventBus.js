'use strict';

/**
 * In-memory event bus.
 *
 * API:
 *   eventBus.subscribe(typeOrStar, handler)   // returns unsubscribe()
 *   eventBus.publish(event)                   // returns Promise<void>
 *   eventBus.reset()                          // test helper
 *
 * Built-in persistent subscriber (`persistToAudit`) writes every event to
 * `audit_events` SYNCHRONOUSLY before any user subscribers run. This means
 * the event is durable even if the process dies during fan-out.
 *
 * Phase 5+ will swap the in-memory bus for a real queue (Postgres
 * LISTEN/NOTIFY or Redis Streams) without changing the publish() API.
 */

const logger = require('../config/logger');

let _db = null; // dependency-injected DB facade; see init()
const handlers = new Map(); // type -> Set<handler>

function _list(type) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  return handlers.get(type);
}

function subscribe(type, handler) {
  if (typeof handler !== 'function') throw new Error('subscribe: handler must be a function');
  if (!type) throw new Error('subscribe: type is required (or "*")');
  _list(type).add(handler);
  return function unsubscribe() { _list(type).delete(handler); };
}

async function persistToAudit(event) {
  if (!_db || typeof _db.insertAuditEvent !== 'function') {
    // No DB facade attached - log but don't throw. Tests can run without DB.
    logger.warn({ event_type: event.event_type }, '[eventBus] no DB facade; audit row skipped');
    return;
  }
  try {
    // 1) audit_events - the full audit trail (every event, including command.*)
    await _db.insertAuditEvent(event);
    // 2) event_store - the canonical domain event log. Phase 3+: mandatory.
    //    Skip for purely-operational events: command.* and query.* live only in audit_events.
    //    Domain events go to BOTH.
    if (_db.insertDomainEvent && _isDomainEvent(event)) {
      await _db.insertDomainEvent(event);
    }
  } catch (err) {
    // Persistence failure must not silently lose the event - log loud and
    // re-throw so the publisher (and the command bus) can roll back.
    logger.error({ err, event_type: event.event_type }, '[eventBus] persistToAudit failed');
    throw err;
  }
}

function _isDomainEvent(event) {
  // command.*, query.*, authz.* are pipeline/audit events - skip event_store
  const t = String(event.event_type || '');
  return !(t.startsWith('command.') || t.startsWith('query.') || t.startsWith('authz.'));
}

async function publish(event) {
  if (!event || !event.event_type) throw new Error('publish: event must have event_type');

  // 1. Built-in: persist to audit_events FIRST (synchronously). If this
  //    throws, no user subscriber runs and the publisher gets the error.
  await persistToAudit(event);

  // 2. Fan-out to user subscribers - both exact-type and '*' subscribers.
  const exact = Array.from(_list(event.event_type));
  const wild  = Array.from(_list('*'));
  const fans  = exact.concat(wild);

  for (const h of fans) {
    try {
      // Sequential await: subscribers can rely on ordering for the same event.
      // (Phase 5 queue can change this contract intentionally; document then.)
      await h(event);
    } catch (err) {
      // A user subscriber throwing does NOT undo the audit row or block
      // other subscribers - just log and continue.
      logger.error({ err, event_type: event.event_type }, '[eventBus] subscriber error');
    }
  }
}

function init({ db } = {}) {
  _db = db || null;
}

function reset() {
  handlers.clear();
  _db = null;
}

module.exports = { subscribe, publish, init, reset };
