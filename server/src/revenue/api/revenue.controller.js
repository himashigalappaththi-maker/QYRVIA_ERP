'use strict';

/**
 * Revenue Management HTTP controller. Thin: reads req.ctx + query/body, calls
 * the RevenueEngine facade, returns JSON. Read-only on upstream systems.
 */

function buildController({ revenue }) {
  const ctxOf = (req) => req.ctx || {};
  const fail = (res, req, code, status = 400) => res.status(status).json({ ok: false, error: code, requestId: ctxOf(req).requestId });
  const ok = (res, req, result) => res.json({ ok: true, result, requestId: ctxOf(req).requestId });

  return {
    async getRate(req, res, next) {
      try {
        const q = req.query || {};
        if (!q.room_type_id || !q.date) return fail(res, req, 'room_type_id_and_date_required');
        ok(res, req, await revenue.getRate(ctxOf(req), {
          roomTypeId: q.room_type_id, date: q.date,
          leadTimeDays: q.lead_time_days != null ? Number(q.lead_time_days) : undefined,
          lengthOfStay: q.length_of_stay != null ? Number(q.length_of_stay) : undefined,
          reservationId: q.reservation_id }));
      } catch (e) { if (/required|not_found/.test(e.message)) return fail(res, req, e.message); next(e); }
    },
    async rateGrid(req, res, next) {
      try {
        const q = req.query || {};
        if (!q.room_type_id || !q.date_from || !q.date_to) return fail(res, req, 'room_type_id_date_from_date_to_required');
        ok(res, req, await revenue.generateRateGrid(ctxOf(req), { roomTypeId: q.room_type_id, dateFrom: q.date_from, dateTo: q.date_to }));
      } catch (e) { if (/required|not_found/.test(e.message)) return fail(res, req, e.message); next(e); }
    },
    async forecast(req, res, next) {
      try {
        const q = req.query || {};
        if (!q.date_from || !q.date_to) return fail(res, req, 'date_range_required');
        ok(res, req, await revenue.getForecast(ctxOf(req), { dateFrom: q.date_from, dateTo: q.date_to }));
      } catch (e) { next(e); }
    },
    async kpis(req, res, next) {
      try { ok(res, req, await revenue.getRevenueKPIs(ctxOf(req), { dateFrom: req.query.date_from, dateTo: req.query.date_to })); }
      catch (e) { next(e); }
    },
    async dashboard(req, res, next) {
      try { ok(res, req, await revenue.getRevenueDashboard(ctxOf(req), { dateFrom: req.query.date_from, dateTo: req.query.date_to })); }
      catch (e) { next(e); }
    },
    async setRatePlan(req, res, next) {
      try { ok(res, req, await revenue.setRatePlan(ctxOf(req), req.body || {})); }
      catch (e) { if (/required|>/.test(e.message)) return fail(res, req, e.message); next(e); }
    },
    async override(req, res, next) {
      try { ok(res, req, await revenue.applyManualOverride(ctxOf(req), req.body || {})); }
      catch (e) { if (/required/.test(e.message)) return fail(res, req, e.message); next(e); }
    }
  };
}

module.exports = { buildController };
