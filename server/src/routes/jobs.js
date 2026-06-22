'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');

function build({ scheduler }) {
  const router = express.Router();
  if (!scheduler) return router;

  // POST /api/jobs - schedule a job
  router.post('/', requirePermission('jobs.schedule'), async (req, res, next) => {
    try {
      const { job_type, payload, run_at, property_id, max_attempts } = req.body || {};
      if (!job_type) return res.status(400).json({ error: 'missing_job_type', requestId: req.ctx.requestId });
      const r = await scheduler.scheduleJob({
        tenantId:     req.ctx.tenantId,
        propertyId:   property_id || req.ctx.propertyId,
        jobType:      job_type,
        payload:      payload || {},
        runAt:        run_at || new Date().toISOString(),
        maxAttempts:  max_attempts || 3,
        createdBy:    req.ctx.actorId
      }, req.ctx);
      res.status(201).json({ ok: true, id: r.id, requestId: req.ctx.requestId });
    } catch (err) { next(err); }
  });

  // DELETE /api/jobs/:id - cancel pending
  router.delete('/:id', requirePermission('jobs.schedule'), async (req, res, next) => {
    try {
      const r = await scheduler.cancelJob(req.params.id, req.ctx);
      res.json(Object.assign({ requestId: req.ctx.requestId }, r));
    } catch (err) { next(err); }
  });

  // POST /api/jobs/run - operator-triggered execution loop
  router.post('/run', requirePermission('jobs.schedule'), async (req, res, next) => {
    try {
      const limit = parseInt((req.body && req.body.limit) || 25, 10);
      const r = await scheduler.executeDueJobs({ limit });
      res.json(Object.assign({ ok: true, requestId: req.ctx.requestId }, r));
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { build };
