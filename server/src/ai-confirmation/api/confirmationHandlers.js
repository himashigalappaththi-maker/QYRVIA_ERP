'use strict';

/**
 * AI Booking Confirmation HTTP handlers (Phase 27.3) - thin read/operational surface
 * over the confirmation service. All reads are tenant-scoped via req.ctx.tenantId
 * (multi-tenant isolation). No PMS/OTA writes. Extracted from the route for unit tests.
 */

function buildConfirmationHandlers({ aiConfirmation } = {}) {
  if (!aiConfirmation || !aiConfirmation.service) throw new Error('confirmationHandlers: aiConfirmation.service required');
  const svc = aiConfirmation.service;

  return {
    // GET /status - counters + current mode for this tenant
    status(req, res) {
      const ctx = req.ctx || {};
      return res.status(200).json({ ok: true, enabled: true, status: svc.stats(ctx.tenantId), requestId: ctx.requestId });
    },
    // GET /escalations - confirmations awaiting staff follow-up
    escalations(req, res) {
      const ctx = req.ctx || {};
      return res.status(200).json({ ok: true, items: svc.listEscalations(ctx.tenantId), requestId: ctx.requestId });
    },
    // GET /dead-letter - confirmations that failed every delivery attempt
    deadLetter(req, res) {
      const ctx = req.ctx || {};
      return res.status(200).json({ ok: true, items: svc.listDeadLetter(ctx.tenantId), requestId: ctx.requestId });
    },
    // POST /drain - flush the pending queue now (delivers via transport)
    async drain(req, res, next) {
      try { const ctx = req.ctx || {}; const results = await svc.drain(); return res.status(200).json({ ok: true, processed: results.length, requestId: ctx.requestId }); }
      catch (e) { next(e); }
    },
    // POST /replay - re-queue dead-lettered confirmations, then drain
    async replay(req, res, next) {
      try {
        const ctx = req.ctx || {};
        const requeued = svc.replayDeadLetter();
        const results = await svc.drain();
        return res.status(200).json({ ok: true, requeued, processed: results.length, requestId: ctx.requestId });
      } catch (e) { next(e); }
    }
  };
}

module.exports = { buildConfirmationHandlers };
