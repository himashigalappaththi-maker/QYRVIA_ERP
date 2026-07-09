'use strict';

/**
 * Booking Engine HTTP handlers (Phase 26) - thin: read req.ctx + body, call the
 * BookingService (the single orchestration gate), map the result to JSON. All
 * reservation writes flow through here -> BookingService -> commandBus -> PMS.
 * Extracted from the route so it is unit-testable without HTTP.
 *
 * Phase 52: buildQuoteHandler({ ariService }) — GET /api/booking/quote.
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

/**
 * Phase 52 D5 — Quote handler factory.
 * buildQuoteHandler({ ariService }) -> async handler for GET /api/booking/quote
 *
 * No ariService injected => 200 { ok: true, data: { bookable: false, reason: 'ari_not_configured' } }
 */
function buildQuoteHandler({ ariService } = {}) {
  return async function quoteHandler(req, res, next) {
    try {
      const ctx = req.ctx || {};

      // Tenant context required
      if (!ctx.tenantId) {
        return res.status(401).json({ ok: false, error: 'tenant_required' });
      }

      // ARI not configured — graceful degradation
      if (!ariService || typeof ariService.quoteStay !== 'function') {
        return res.status(200).json({ ok: true, data: { bookable: false, reason: 'ari_not_configured' } });
      }

      const q = req.query || {};
      const roomTypeId  = q.room_type_id  || null;
      const arrival     = q.arrival       || null;
      const departure   = q.departure     || null;
      const adults      = q.adults ? Number(q.adults) : 1;
      const ratePlanId  = q.rate_plan_id  || null;
      const channel     = q.channel       || 'DIRECT';

      // Required params guard
      if (!roomTypeId || !arrival || !departure) {
        return res.status(400).json({
          ok: false,
          error: 'missing_required_params',
          required: ['room_type_id', 'arrival', 'departure']
        });
      }

      const result = await ariService.quoteStay({
        tenantId:   ctx.tenantId,
        propertyId: ctx.propertyId || null,
        roomTypeId,
        ratePlanId,
        arrival,
        departure,
        adults,
        channel
      });

      if (result.bookable) {
        return res.status(200).json({
          ok: true,
          data: {
            bookable:      true,
            total:         result.total,
            currency:      result.currency,
            los:           result.los,
            available:     result.available,
            nightly_rates: result.nights || [],
            rate_plan_name: result.rate_plan_name || null,
            reasons:       []
          }
        });
      }

      return res.status(400).json({
        ok: false,
        error: 'not_bookable',
        reasons: result.reasons || []
      });
    } catch (err) {
      // Don't call next(err) — return 500 envelope per spec
      return res.status(500).json({ ok: false, error: 'quote_failed', message: err && err.message });
    }
  };
}

module.exports = { buildBookingHandlers, buildQuoteHandler };
