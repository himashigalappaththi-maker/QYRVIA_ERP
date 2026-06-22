'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');

function build({ settingsService }) {
  const router = express.Router();
  if (!settingsService) return router;

  // ---- Phase 6 / C14: settings catalog (typed schema) ------------------
  // Registered IN CODE at boot (settingsCatalogBoot.js). Read-only here.
  router.get('/schema', requirePermission('settings.schema.read'), (req, res) => {
    const cat  = req.query && req.query.category;
    const rows = settingsService.listCatalog(cat || null);
    res.json({ ok: true, data: rows, requestId: req.ctx.requestId });
  });
  router.get('/schema/:category/:key', requirePermission('settings.schema.read'), (req, res) => {
    const spec = settingsService.lookupSpec(req.params.category, req.params.key);
    if (!spec) {
      return res.status(404).json({ ok: false, error: 'spec_not_found', requestId: req.ctx.requestId });
    }
    res.json({ ok: true, data: spec, requestId: req.ctx.requestId });
  });

  // GET /api/settings/:category - list within category
  router.get('/:category', requirePermission('settings.read'), async (req, res, next) => {
    try {
      const rows = await settingsService.list(req.params.category, { ctx: req.ctx });
      res.json({ ok: true, data: rows, requestId: req.ctx.requestId });
    } catch (err) { next(err); }
  });

  // GET /api/settings/:category/:key
  router.get('/:category/:key', requirePermission('settings.read'), async (req, res, next) => {
    try {
      const v = await settingsService.get(req.params.category, req.params.key, { ctx: req.ctx });
      res.json({ ok: true, value: v, requestId: req.ctx.requestId });
    } catch (err) { next(err); }
  });

  // PUT /api/settings/:category/:key  body: { value, scope? }
  router.put('/:category/:key', requirePermission('settings.write'), async (req, res, next) => {
    try {
      const body  = req.body || {};
      const scope = body.scope === 'property' ? 'property' : 'tenant';
      const r = await settingsService.set(req.params.category, req.params.key, body.value, { ctx: req.ctx, scope });
      res.status(r.ok ? 200 : 400).json(Object.assign({ requestId: req.ctx.requestId }, r));
    } catch (err) { next(err); }
  });

  // DELETE /api/settings/:category/:key
  router.delete('/:category/:key', requirePermission('settings.write'), async (req, res, next) => {
    try {
      const scope = req.query.scope === 'property' ? 'property' : 'tenant';
      const r = await settingsService.delete(req.params.category, req.params.key, { ctx: req.ctx, scope });
      res.json(Object.assign({ requestId: req.ctx.requestId }, r));
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { build };
