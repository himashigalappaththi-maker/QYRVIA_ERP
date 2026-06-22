'use strict';

/**
 * Channel event payload builders. Keep payloads small + serializable (they are
 * persisted to event_store as JSONB and may be replayed long after the fact).
 */

const { EVENT_TYPES } = require('./EventTypes');

function bookingCreated(b) {
  return { type: EVENT_TYPES.BOOKING_CREATED, aggregateId: b.bookingId,
    payload: { booking_id: b.bookingId, channel: b.channel, status: b.status,
      guest_name: b.guestName, arrival: b.arrival, departure: b.departure,
      amount: b.amount, currency: b.currency, external_ref: b.externalRef } };
}
function bookingConfirmed(b) {
  return { type: EVENT_TYPES.BOOKING_CONFIRMED, aggregateId: b.bookingId,
    payload: { booking_id: b.bookingId, channel: b.channel } };
}
function bookingCancelled(b) {
  return { type: EVENT_TYPES.BOOKING_CANCELLED, aggregateId: b.bookingId,
    payload: { booking_id: b.bookingId, channel: b.channel } };
}
function inventoryUpdated(channel, inv) {
  return { type: EVENT_TYPES.INVENTORY_UPDATED, aggregateId: inv.propertyId + ':' + inv.roomTypeId + ':' + inv.date,
    payload: { channel, property_id: inv.propertyId, room_type_id: inv.roomTypeId,
      date: inv.date, available: inv.available, stop_sell: inv.stopSell } };
}
function rateUpdated(channel, rate) {
  return { type: EVENT_TYPES.RATE_UPDATED, aggregateId: rate.propertyId + ':' + rate.roomTypeId + ':' + rate.date,
    payload: { channel, property_id: rate.propertyId, room_type_id: rate.roomTypeId,
      rate_plan_id: rate.ratePlanId, date: rate.date, amount: rate.amount, currency: rate.currency } };
}
function syncFailed(channel, op, detail) {
  return { type: EVENT_TYPES.SYNC_FAILED, aggregateId: channel + ':' + op,
    payload: { channel, op, detail: String(detail || '') } };
}

module.exports = { bookingCreated, bookingConfirmed, bookingCancelled, inventoryUpdated, rateUpdated, syncFailed };
