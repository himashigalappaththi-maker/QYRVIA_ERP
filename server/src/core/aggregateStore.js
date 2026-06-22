'use strict';

/**
 * Aggregate Store - event-sourcing foundation.
 *
 * An aggregate is identified by (tenant_id, aggregate_type, aggregate_id).
 * Its state is the fold of all events for that stream (or snapshot + tail).
 *
 *   loadAggregate(ctx, type, id, reducer)
 *     -> { aggregate, version }
 *     reads latest snapshot (if any) + events with version > snapshot.version,
 *     reduces into final state.
 *
 *   appendEvents(ctx, type, id, expectedVersion, events)
 *     -> { ok:true, newVersion } | { ok:false, error:'version_conflict', currentVersion }
 *     events: [ { event_type, payload } ]
 *     Each event is assigned version expectedVersion+1, +2, ...
 *     Inserted via the eventBus (audit_events + event_store written atomically).
 *
 *   saveSnapshot(ctx, type, id, version, state)
 *     -> overwrites the single snapshot row for this aggregate
 *
 * Optimistic concurrency: the unique index ux_event_store_version on
 * (tenant_id, aggregate_type, aggregate_id, event_version) means two
 * appendEvents() racing for the same expectedVersion will collide; the
 * second caller gets { error: 'version_conflict' }.
 *
 * DI: takes a repo facade. The eventBus is used to publish each event
 * AFTER successful persistence in event_store (audit fan-out only - the
 * version-controlled persistence path writes event_store directly inside
 * appendEvents).
 */

const { makeEvent } = require('./event');
const eventBus      = require('./eventBus');
const logger        = require('../config/logger');

function buildAggregateStore({ repo }) {
  if (!repo) throw new Error('buildAggregateStore: repo required');

  async function loadAggregate(ctx, aggregateType, aggregateId, reducer) {
    if (!ctx || !ctx.tenantId) throw new Error('loadAggregate: ctx.tenantId required');
    if (!aggregateType || !aggregateId) throw new Error('loadAggregate: type+id required');
    if (typeof reducer !== 'function') throw new Error('loadAggregate: reducer required');

    const snap = await repo.findLatestSnapshot(ctx.tenantId, aggregateType, aggregateId);
    let state    = snap ? snap.snapshot_json : null;
    let fromVer  = snap ? snap.aggregate_version : 0;
    const events = await repo.listAggregateEvents(ctx.tenantId, aggregateType, aggregateId, fromVer);
    let version  = fromVer;
    for (const ev of events) {
      state = reducer(state, ev);
      version = ev.event_version;
    }
    return { aggregate: state, version };
  }

  async function appendEvents(ctx, aggregateType, aggregateId, expectedVersion, events) {
    if (!ctx || !ctx.tenantId)        throw new Error('appendEvents: ctx.tenantId required');
    if (!ctx.requestId)               throw new Error('appendEvents: ctx.requestId required');
    if (!Array.isArray(events) || !events.length) {
      return { ok: false, error: 'no_events' };
    }
    const currentVersion = await repo.getCurrentVersion(ctx.tenantId, aggregateType, aggregateId);
    if (Number.isInteger(expectedVersion) && expectedVersion !== currentVersion) {
      return { ok: false, error: 'version_conflict', currentVersion };
    }
    let nextVersion = currentVersion;
    const persisted = [];
    try {
      for (const e of events) {
        if (!e.event_type) return { ok: false, error: 'invalid_event', detail: 'event_type required' };
        nextVersion++;
        const ev = makeEvent({
          type:          e.event_type,
          aggregateType, aggregateId,
          payload:       e.payload || {},
          ctx
        });
        // Persist with explicit version. Unique index will reject racing duplicates.
        await repo.appendEventWithVersion({
          event_id:       ev.event_id,
          tenant_id:      ev.tenant_id,
          property_id:    ev.property_id,
          aggregate_type: aggregateType,
          aggregate_id:   aggregateId,
          event_type:     ev.event_type,
          event_version:  nextVersion,
          payload_json:   ev.payload,
          actor_id:       ev.actor_id,
          request_id:     ev.request_id,
          occurred_at:    ev.occurred_at
        });
        persisted.push(ev);
      }
    } catch (err) {
      // unique-index violation = version conflict
      if (err && (err.code === '23505' || /unique/i.test(String(err.message || '')))) {
        const current = await repo.getCurrentVersion(ctx.tenantId, aggregateType, aggregateId);
        return { ok: false, error: 'version_conflict', currentVersion: current };
      }
      throw err;
    }
    // Fan out audit + downstream subscribers (eventBus) for each event
    for (const ev of persisted) {
      try { await eventBus.publish(ev); }
      catch (err) { logger.error({ err, event_type: ev.event_type }, '[aggregateStore] publish failed'); }
    }
    return { ok: true, newVersion: nextVersion };
  }

  async function saveSnapshot(ctx, aggregateType, aggregateId, version, state) {
    if (!ctx || !ctx.tenantId) throw new Error('saveSnapshot: ctx.tenantId required');
    if (!Number.isInteger(version) || version < 0) throw new Error('saveSnapshot: invalid version');
    await repo.upsertSnapshot({
      tenant_id:          ctx.tenantId,
      aggregate_type:     aggregateType,
      aggregate_id:       aggregateId,
      aggregate_version:  version,
      snapshot_json:      state
    });
    return { ok: true };
  }

  return { loadAggregate, appendEvents, saveSnapshot };
}

module.exports = { buildAggregateStore };
