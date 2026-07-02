'use strict';

/**
 * Channel Manager HTTP controller. Thin: validates request shape, calls
 * ChannelManagerCore, maps the result to a JSON response. Domain events are
 * emitted inside the core (through the shared eventBus -> event_store), so the
 * controller never publishes events directly.
 */

const { errorField } = require('../../middleware/errorEnvelope');
const { buildChannelConnectionTester } = require('../services/channelConnectionTester');

function buildController({ channelManager, deadLetter }) {
  // Phase 37 WI-2b: readiness-only connection tester, built once. It is fail-closed
  // and side-effect-free (no network, no send, no secret resolution).
  const connectionTester = buildChannelConnectionTester({ channelManager });

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

    async testConnection(req, res, next) {
      try {
        // Phase 37 WI-2b: readiness-only diagnostic probe. Uses the READ envelope.
        // The tester is fail-closed (missing tenantId => ready:false) and performs
        // NO network, NO send(), NO secret resolution; ready:false is a valid 200
        // payload (with reason), never an HTTP error.
        const b = req.body || {};
        if (!b.channel) return fail(res, req, 'channel_required');
        const ctx = ctxOf(req);
        const result = await connectionTester.test(b.channel, ctx);
        res.json({ ok: true, data: { ...result, probe: 'readiness_only' }, requestId: ctx.requestId });
      } catch (e) { next(e); }
    },

    async status(req, res, next) {
      try {
        // READ envelope (Phase 23 R1): the single GET emits { ok, data }; sync writes keep { ok, result }.
        res.json({ ok: true, data: channelManager.status(), requestId: ctxOf(req).requestId });
      } catch (e) { next(e); }
    },

    // Phase 37 WI-3: channel operational surfaces (READ envelope). Non-secret,
    // metadata-only; fail-closed on missing tenant. No network, no OTA calls.

    // GET /api/channel/sync-health - core status + tenant-scoped dead-letter count.
    async syncHealth(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        const s = channelManager.status() || {};
        const tenantCount = deadLetter ? (await deadLetter.list({ tenant_id: ctx.tenantId })).length : null;
        res.json({
          ok: true,
          data: {
            channels: s.channels,
            queue: s.queue,
            bookings: s.bookings,
            deadLetters: { tenantCount }
          },
          requestId: ctx.requestId
        });
      } catch (e) { next(e); }
    },

    // GET /api/channel/dlq - tenant-scoped dead-letter metadata (NO payload_json).
    async dlqList(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        if (!deadLetter) return res.json({ ok: true, data: { items: [] }, requestId: ctx.requestId });
        const rows = await deadLetter.list({ tenant_id: ctx.tenantId });
        const items = (rows || []).map((r) => ({
          id: r.id,
          channel: r.channel,
          action: r.action,
          reservation_id: r.reservation_id,
          attempts: r.attempts,
          last_error: r.last_error,
          reprocess_requested: r.reprocess_requested,
          created_at: r.created_at,
          updated_at: r.updated_at
        }));
        res.json({ ok: true, data: { items }, requestId: ctx.requestId });
      } catch (e) { next(e); }
    },

    // POST /api/channel/dlq/reprocess - flags reprocess_requested (NO network, NO OTA).
    async dlqReprocess(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        const id = (req.body || {}).id;
        if (!id) return fail(res, req, 'id_required');
        if (!deadLetter) return fail(res, req, 'dlq_unavailable', 400);
        // Ownership guard: never reveal cross-tenant existence.
        const rec = await deadLetter.get(id);
        if (!rec || rec.tenant_id !== ctx.tenantId) return fail(res, req, 'dead_letter_not_found', 404);
        const out = await deadLetter.requestReprocess(id);
        res.json({ ok: true, result: { id: out.id, reprocess_requested: out.reprocess_requested }, requestId: ctx.requestId });
      } catch (e) { next(e); }
    }
  };
}

module.exports = { buildController };
