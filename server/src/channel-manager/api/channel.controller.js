'use strict';

/**
 * Channel Manager HTTP controller. Thin: validates request shape, calls
 * ChannelManagerCore, maps the result to a JSON response. Domain events are
 * emitted inside the core (through the shared eventBus -> event_store), so the
 * controller never publishes events directly.
 */

const { errorField } = require('../../middleware/errorEnvelope');

function buildController({ channelManager }) {
  function ctxOf(req) { return req.ctx || {}; }

  function fail(res, req, code, status = 400) {
    return res.status(status).json({ ok: false, error: errorField(code), requestId: ctxOf(req).requestId });
  }

  return {
    async syncRates(req, res, next) {
      try {
        const b = req.body || {};
        if (!b.channel) return fail(res, req, 'channel_required');
        const out = await channelManager.pushRates(b.channel, b, ctxOf(req));
        res.json({ ok: true, result: out, requestId: ctxOf(req).requestId });
      } catch (e) { if (/no adapter|Canonical|required/.test(e.message)) return fail(res, req, e.message); next(e); }
    },

    async syncInventory(req, res, next) {
      try {
        const b = req.body || {};
        if (!b.channel) return fail(res, req, 'channel_required');
        const out = await channelManager.pushInventory(b.channel, b, ctxOf(req));
        res.json({ ok: true, result: out, requestId: ctxOf(req).requestId });
      } catch (e) { if (/no adapter|Canonical|required/.test(e.message)) return fail(res, req, e.message); next(e); }
    },

    async syncBookings(req, res, next) {
      try {
        const b = req.body || {};
        if (!b.channel) return fail(res, req, 'channel_required');
        const out = await channelManager.syncBookings(b.channel, ctxOf(req));
        res.json({ ok: true, result: out, requestId: ctxOf(req).requestId });
      } catch (e) { if (/no adapter|not_implemented/.test(e.message)) return fail(res, req, e.message); next(e); }
    },

    async confirmBooking(req, res, next) {
      try {
        const b = req.body || {};
        if (!b.channel || !b.booking_id) return fail(res, req, 'channel_and_booking_id_required');
        const out = await channelManager.confirmBooking(b.channel, b.booking_id, ctxOf(req));
        res.json({ ok: true, result: out, requestId: ctxOf(req).requestId });
      } catch (e) { if (/no adapter|not_implemented/.test(e.message)) return fail(res, req, e.message); next(e); }
    },

    async cancelBooking(req, res, next) {
      try {
        const b = req.body || {};
        if (!b.channel || !b.booking_id) return fail(res, req, 'channel_and_booking_id_required');
        const out = await channelManager.cancelBooking(b.channel, b.booking_id, ctxOf(req));
        res.json({ ok: true, result: out, requestId: ctxOf(req).requestId });
      } catch (e) { if (/no adapter|not_implemented/.test(e.message)) return fail(res, req, e.message); next(e); }
    },

    async status(req, res, next) {
      try {
        // READ envelope (Phase 23 R1): the single GET emits { ok, data }; sync writes keep { ok, result }.
        res.json({ ok: true, data: channelManager.status(), requestId: ctxOf(req).requestId });
      } catch (e) { next(e); }
    }
  };
}

module.exports = { buildController };
