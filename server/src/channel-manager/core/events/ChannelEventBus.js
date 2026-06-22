'use strict';

/**
 * ChannelEventBus - the channel layer's seam onto the kernel event bus.
 *
 * It does NOT invent a parallel bus. It wraps the shared `core/eventBus`, so
 * every channel event is persisted (audit_events + event_store), append-only,
 * and fanned out to existing subscribers (webhooks, etc.). This is the Phase
 * 9.1 DB-truth integration point: events are durable + replayable from
 * event_store and align with the same transaction boundaries as the rest of
 * the system.
 *
 *   const bus = new ChannelEventBus();              // uses the singleton
 *   await bus.emit(events.bookingCreated(b), ctx);  // persists + fans out
 *   ChannelEventBus.replay(rows, reducer, init);    // fold persisted events
 */

const { makeEvent } = require('../../../core/event');
const sharedEventBus = require('../../../core/eventBus');

class ChannelEventBus {
  constructor({ eventBus = sharedEventBus } = {}) {
    this._bus = eventBus;
  }

  /**
   * Persist + publish a channel event. `evt` is a {type, aggregateId, payload}
   * from events.js; `ctx` supplies tenant/property/request for makeEvent.
   * Idempotency at the event level is the caller's concern (see QueueManager
   * idempotency keys + reducer-level dedupe).
   */
  async emit(evt, ctx) {
    const event = makeEvent({
      type: evt.type, aggregateType: 'channel',
      aggregateId: String(evt.aggregateId), payload: evt.payload || {}, ctx
    });
    await this._bus.publish(event);
    return event;
  }

  subscribe(type, handler) { return this._bus.subscribe(type, handler); }

  /**
   * Replay persisted events back into state. Pure fold - proves events are
   * replayable and that state is a deterministic function of the event log.
   */
  static replay(events, reducer, initial) {
    return (events || []).reduce((state, ev) => reducer(state, ev), initial);
  }
}

module.exports = { ChannelEventBus };
