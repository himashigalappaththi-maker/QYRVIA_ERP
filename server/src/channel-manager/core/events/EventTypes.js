'use strict';

/**
 * Channel Manager domain event types.
 *
 * NOTE: the kernel's `makeEvent` (src/core/event.js) enforces a single-dot
 * `aggregate.verb_past` shape, so the brief's `BookingCreated` etc. map to:
 *   BookingCreated   -> channel.booking_created
 *   BookingCancelled -> channel.booking_cancelled
 *   InventoryUpdated -> channel.inventory_updated
 *   RateUpdated      -> channel.rate_updated
 * Published through the shared eventBus, so they land in audit_events +
 * event_store (append-only, replayable) exactly like every other domain event.
 */

const EVENT_TYPES = Object.freeze({
  BOOKING_CREATED:   'channel.booking_created',
  BOOKING_CONFIRMED: 'channel.booking_confirmed',
  BOOKING_CANCELLED: 'channel.booking_cancelled',
  INVENTORY_UPDATED: 'channel.inventory_updated',
  RATE_UPDATED:      'channel.rate_updated',
  SYNC_FAILED:       'channel.sync_failed'
});

module.exports = { EVENT_TYPES };
