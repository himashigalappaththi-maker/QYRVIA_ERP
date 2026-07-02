'use strict';

/**
 * Booking Engine HTTP handlers (Phase 26) - thin: read req.ctx + body, call the
 * BookingService (the single orchestration gate), map the result to JSON. All
 * reservation writes flow through here -> BookingService -> commandBus -> PMS.
 * Extracted from the route so it is unit-testable without HTTP.
 */

function buildBookingHandlers({ bookingEngine }) {
  if (!bookingEngine || !bookingEngine.service) throw new Error('bookingHandlers: bookingEngine.service required');
  const svc = bookingEngine.service;

  function send(res, ctx, out) {
    if (out && out.ok) {
      return res.status(200).json({ ok: true, result: { reservation_id: out.reservation_id || null, action: out.action || 'create', pricing: out.pricing || null }, requestId: ctx.requestId });
    }
    const reason = (out && out.reason) || 'booking_failed';
    const status = reason === 'tenant_required' ? 401 : 400;
    return res.status(status).json({ ok: false, error: reason, detail: out && out.detail, requestId: ctx.requestId });
  }

  return {
    async create(req, res, next) {
      try { const ctx = req.ctx || {}; send(res, ctx, await svc.createBooking(req.body || {}, ctx)); }
      catch (e) { next(e); }
    },
    async update(req, res, next) {
      try { const ctx = req.ctx || {}; const body = Object.assign({}, req.body || {}, { reservation_id: req.params.id }); send(res, ctx, await svc.updateBooking(body, ctx)); }
      catch (e) { next(e); }
    },
    async cancel(req, res, next) {
      try { const ctx = req.ctx || {}; const body = Object.assign({}, req.body || {}, { reservation_id: req.params.id }); send(res, ctx, await svc.cancelBooking(body, ctx)); }
      catch (e) { next(e); }
    }
  };
}

module.exports = { buildBookingHandlers };
