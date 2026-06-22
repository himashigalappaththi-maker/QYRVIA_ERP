'use strict';

/**
 * platformSubscriber (Phase 18) - centralizes observability + enterprise
 * analytics by consuming the whole domain event stream READ-ONLY. It feeds the
 * audit aggregator, metrics, and cross-property analytics. It never mutates
 * upstream state.
 */

function buildPlatformSubscriber({ eventBus, platform } = {}) {
  if (!eventBus) throw new Error('platformSubscriber: eventBus required');
  if (!platform) throw new Error('platformSubscriber: platform required');

  const unsub = eventBus.subscribe('*', async (e) => {
    try {
      const type = String(e.event_type || '');
      platform.metrics.increment('events_total', 1, { type });
      await platform.audit.ingest({ type, propertyId: e.property_id || null, userId: e.actor_id || null, correlationId: e.request_id || null });

      if (type === 'invoice.finalized' && e.payload) {
        platform.analytics.record(e.property_id, { revenue: Number(e.payload.total) || 0 });
      }
      if (type === 'dayend.completed' && e.payload && e.payload.summary) {
        platform.analytics.record(e.property_id, { demand: Number(e.payload.summary.staysEnded) || 0 });
      }
      if (type === 'reservation.created') platform.metrics.increment('bookings_total', 1, { property: e.property_id || '-' });
    } catch (_) { /* observability must never break the bus */ }
  });

  return function unsubscribe() { try { unsub(); } catch (_) { /* ignore */ } };
}

module.exports = { buildPlatformSubscriber };
