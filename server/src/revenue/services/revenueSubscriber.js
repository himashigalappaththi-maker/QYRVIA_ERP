'use strict';

/**
 * revenueSubscriber - feeds the demand window from upstream events. SUBSCRIBES
 * read-only; never mutates upstream systems. On day-end it rolls the window
 * into history.
 */

function ctxFromEvent(e) {
  return { tenantId: e.tenant_id, propertyId: e.property_id, requestId: 'rev-sub-' + (e.event_id || 'na'), userId: e.actor_id || null };
}

function buildRevenueSubscriber({ eventBus, revenue } = {}) {
  if (!eventBus) throw new Error('revenueSubscriber: eventBus required');
  if (!revenue) throw new Error('revenueSubscriber: revenue required');

  const unsubs = [];
  const on = (type, handler) => unsubs.push(eventBus.subscribe(type, async (e) => {
    try { if (e.property_id) await handler(e); } catch (_) { /* isolated */ }
  }));

  on('reservation.created', (e) => revenue.demand.reservationCreated(ctxFromEvent(e)));
  on('reservation.cancelled', (e) => revenue.demand.reservationCancelled(ctxFromEvent(e)));

  // check-in / check-out signals (accept Front Desk + Reservation variants)
  for (const t of ['stay.started', 'stay.checked_in', 'reservation.checked_in']) on(t, (e) => revenue.demand.checkIn(ctxFromEvent(e)));
  for (const t of ['stay.ended', 'stay.checked_out', 'reservation.completed']) on(t, (e) => revenue.demand.checkOut(ctxFromEvent(e)));

  on('invoice.finalized', (e) => revenue.demand.recordRevenue(ctxFromEvent(e), { amount: (e.payload && e.payload.total) || 0, rooms: 1 }));

  on('dayend.completed', (e) => revenue.rolloverDay(ctxFromEvent(e), { businessDate: (e.payload && e.payload.closed_date) || null }));

  return function unsubscribe() { unsubs.forEach((u) => { try { u(); } catch (_) { /* ignore */ } }); };
}

module.exports = { buildRevenueSubscriber, ctxFromEvent };
