'use strict';

const crypto = require('crypto');

/**
 * Domain event factory + validator.
 *
 * A QYRVIA domain event is an immutable record of something that has happened.
 * Shape:
 *   {
 *     event_id:       uuid,
 *     event_type:     '<aggregate>.<verb_past>'   // e.g. 'reservation.created'
 *     aggregate_type: '<aggregate>',              // e.g. 'reservation'
 *     aggregate_id:   '<domain id>',
 *     tenant_id:      uuid,
 *     property_id:    uuid | null,
 *     actor_id:       uuid | null,
 *     request_id:     string,
 *     payload:        { ... },
 *     occurred_at:    ISO timestamp
 *   }
 *
 * Events MUST be derived from successful commands (or from internal system
 * subscribers). HTTP route handlers MUST NOT publish events directly.
 */

const TYPE_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

function makeEvent({ type, aggregateType, aggregateId, payload, ctx }) {
  if (typeof type !== 'string' || !TYPE_RE.test(type)) {
    throw new Error('event.type must match <aggregate>.<verb_past>, got: ' + JSON.stringify(type));
  }
  if (!aggregateType) throw new Error('event.aggregateType is required');
  if (!aggregateId)   throw new Error('event.aggregateId is required');
  if (!ctx || !ctx.tenantId)  throw new Error('event ctx.tenantId is required');
  if (!ctx.requestId) throw new Error('event ctx.requestId is required');

  return Object.freeze({
    event_id:       crypto.randomUUID(),
    event_type:     type,
    aggregate_type: String(aggregateType),
    aggregate_id:   String(aggregateId),
    tenant_id:      ctx.tenantId,
    property_id:    ctx.propertyId || null,
    actor_id:       ctx.actorId || null,
    request_id:     ctx.requestId,
    payload:        payload || {},
    occurred_at:    new Date().toISOString()
  });
}

module.exports = { makeEvent, TYPE_RE };
