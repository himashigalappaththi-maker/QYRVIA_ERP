'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');
const { runWithAudit } = require('../audit/pipeline');

/**
 * /api/attendance — Event-based attendance check-in / check-out.
 *
 * Event-based only. No continuous tracking. No background GPS collection.
 * GPS coordinates are optional and recorded only at the explicit event time.
 *
 * RBAC:
 *   attendance.record  — check-in or check-out (own record)
 *   attendance.read    — list own events
 *   attendance.manage  — list all events for the property (management view)
 *
 * user_id is ALWAYS stamped from req.ctx.actorId — never from the request body.
 * tenant_id and property_id are resolved server-side.
 *
 * Duplicate check-in prevention: if an open check-in exists, a second check-in
 * is rejected with 409.
 * Checkout without open check-in: returns 409 with no_open_checkin error.
 */
function build({ attendanceRepo } = {}) {
  const router = express.Router();
  if (!attendanceRepo) return router;

  function handlePropertyError(err, req, res) {
    if (err && err.code === 'ATTENDANCE_PROPERTY_REQUIRED') {
      return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'attendance_property_required' }), true;
    }
    if (err && err.code === 'PROPERTY_ACCESS_DENIED') {
      return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: 'property_access_denied' }), true;
    }
    return false;
  }

  function _validateCoords(body) {
    if (body.latitude != null) {
      const lat = Number(body.latitude);
      if (!isFinite(lat) || lat < -90 || lat > 90) return 'latitude must be between -90 and 90';
    }
    if (body.longitude != null) {
      const lng = Number(body.longitude);
      if (!isFinite(lng) || lng < -180 || lng > 180) return 'longitude must be between -180 and 180';
    }
    if (body.accuracy_meters != null) {
      const acc = Number(body.accuracy_meters);
      if (!isFinite(acc) || acc < 0 || acc > 10000) return 'accuracy_meters must be between 0 and 10000';
    }
    return null;
  }

  // GET /api/attendance/status/my — authoritative check-in status for the calling user.
  // Status is computed server-side. No coordinates returned. No audit event for this read.
  router.get('/status/my', requirePermission('attendance.read'), async (req, res, next) => {
    try {
      const data = await attendanceRepo.getStatus(req.ctx);
      res.json({ ok: true, requestId: req.ctx.requestId, data });
    } catch (err) {
      if (handlePropertyError(err, req, res)) return;
      next(err);
    }
  });

  // POST /api/attendance/events — record check-in or check-out
  router.post('/events', requirePermission('attendance.record'), async (req, res, next) => {
    try {
      const body = req.body || {};
      const eventType = body.event_type;
      if (!eventType || !['check_in', 'check_out'].includes(eventType)) {
        return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'event_type must be check_in or check_out' });
      }
      const coordErr = _validateCoords(body);
      if (coordErr) {
        return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: coordErr });
      }

      // Duplicate / sequence enforcement
      try {
        const openEvent = await attendanceRepo.getOpenCheckIn(req.ctx, req.ctx.actorId);
        if (eventType === 'check_in' && openEvent) {
          return res.status(409).json({ ok: false, requestId: req.ctx.requestId, error: 'open_checkin_exists', detail: 'A check-in is already open. Check out first.' });
        }
        if (eventType === 'check_out' && !openEvent) {
          return res.status(409).json({ ok: false, requestId: req.ctx.requestId, error: 'no_open_checkin', detail: 'No open check-in found. Check in first.' });
        }
      } catch (err) {
        if (handlePropertyError(err, req, res)) return;
        return next(err);
      }

      const rec = {
        user_id:         req.ctx.actorId,   // stamped from JWT — not client body
        event_type:      eventType,
        event_at:        body.event_at || new Date().toISOString(),
        source:          body.source   || 'manual',
        latitude:        body.latitude        != null ? Number(body.latitude)        : null,
        longitude:       body.longitude       != null ? Number(body.longitude)       : null,
        accuracy_meters: body.accuracy_meters != null ? Number(body.accuracy_meters) : null,
        patrol_point_id: body.patrol_point_id || null,
        gate_reference:  body.gate_reference  || null,
        device_reference: body.device_reference || null,
      };

      const outcome = await runWithAudit(
        { name: 'attendance.record', aggregateType: 'attendance_event' },
        { eventType, source: rec.source },
        req.ctx,
        async () => {
          try {
            const row = await attendanceRepo.recordEvent(rec, req.ctx);
            return { ok: true, result: row, entityType: 'attendance_event', entityId: row.id };
          } catch (err) {
            if (err && err.code === 'INVALID_EVENT_TYPE')           return { ok: false, error: 'invalid_event_type' };
            if (err && err.code === 'INVALID_SOURCE')               return { ok: false, error: 'invalid_source' };
            if (err && err.code === 'ATTENDANCE_PROPERTY_REQUIRED') return { ok: false, error: 'attendance_property_required' };
            if (err && err.code === 'PROPERTY_ACCESS_DENIED')       return { ok: false, error: 'property_access_denied' };
            throw err;
          }
        }
      );
      if (!outcome.ok) {
        if (outcome.error === 'attendance_property_required')
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        if (outcome.error === 'property_access_denied')
          return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        if (outcome.error === 'invalid_event_type' || outcome.error === 'invalid_source')
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        return next(Object.assign(new Error(outcome.error || 'attendance_record_failed'), { code: outcome.error }));
      }
      res.status(201).json({ ok: true, requestId: req.ctx.requestId, data: outcome.result });
    } catch (err) { next(err); }
  });

  // GET /api/attendance/events/my — own events only
  router.get('/events/my', requirePermission('attendance.read'), async (req, res, next) => {
    try {
      const rows = await attendanceRepo.listMyEvents(req.ctx, {
        limit: req.query.limit || undefined
      });
      res.json({ ok: true, requestId: req.ctx.requestId, data: rows });
    } catch (err) {
      if (handlePropertyError(err, req, res)) return;
      next(err);
    }
  });

  // GET /api/attendance/events — management view (all staff)
  router.get('/events', requirePermission('attendance.manage'), async (req, res, next) => {
    try {
      const rows = await attendanceRepo.listAllEvents(req.ctx, {
        userId:   req.query.user_id   || undefined,
        dateFrom: req.query.date_from || undefined,
        dateTo:   req.query.date_to   || undefined,
        limit:    req.query.limit     || undefined,
      });
      res.json({ ok: true, requestId: req.ctx.requestId, data: rows });
    } catch (err) {
      if (handlePropertyError(err, req, res)) return;
      next(err);
    }
  });

  return router;
}

module.exports = { build };
