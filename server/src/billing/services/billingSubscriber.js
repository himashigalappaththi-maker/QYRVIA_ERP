'use strict';

/**
 * billingSubscriber - wires the Billing Engine to Phase 13 stay events on the
 * shared eventBus. Billing SUBSCRIBES (read-only on the event stream) and
 * writes financial records; it never calls back into the Stay / Reservation /
 * Room engines.
 *
 *   stay.started        -> open the stay's folio (idempotent)
 *   room.charge_started -> post a room charge IF the event carries a rate
 *                          (unit_rate / nights); otherwise no-op (explicit
 *                          posting via BillingEngine.postRoomCharge is the
 *                          primary path - no coupling to pricing engines)
 *   stay.ended          -> generate a proforma (finalization trigger)
 *
 * Returns an unsubscribe() that detaches all handlers.
 */

function ctxFromEvent(e) {
  return { tenantId: e.tenant_id, propertyId: e.property_id, requestId: 'billing-sub-' + (e.event_id || 'na') };
}

function buildBillingSubscriber({ eventBus, billing } = {}) {
  if (!eventBus) throw new Error('billingSubscriber: eventBus required');
  if (!billing)  throw new Error('billingSubscriber: billing required');

  const unsubs = [];
  const on = (type, handler) => unsubs.push(eventBus.subscribe(type, async (e) => {
    try { await handler(e); } catch (_) { /* subscriber errors are isolated */ }
  }));

  on('stay.started', async (e) => {
    const p = e.payload || {};
    await billing.createFolio(ctxFromEvent(e), { stayId: p.stay_id, reservationId: p.reservation_id, roomId: p.room_id });
  });

  on('room.charge_started', async (e) => {
    const p = e.payload || {};
    if (p.unit_rate == null) return;                 // rate not present -> explicit posting handles it
    const ctx = ctxFromEvent(e);
    const folio = await billing.getFolioByStay(ctx, p.stay_id);
    if (!folio) return;
    await billing.postRoomCharge(ctx, { folioId: folio.folioId, quantity: p.nights || 1, unitRate: p.unit_rate });
  });

  on('stay.ended', async (e) => {
    const p = e.payload || {};
    const ctx = ctxFromEvent(e);
    const folio = await billing.getFolioByStay(ctx, p.stay_id);
    if (!folio) return;
    await billing.generateProforma(ctx, { folioId: folio.folioId });
  });

  return function unsubscribe() { unsubs.forEach((u) => { try { u(); } catch (_) { /* ignore */ } }); };
}

module.exports = { buildBillingSubscriber, ctxFromEvent };
