'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');

function build({ fileService }) {
  const router = express.Router();
  if (!fileService) return router;

  // POST /api/files - upload base64-encoded file in body
  //   { file_name, mime_type, content_base64, property_id? }
  router.post('/', requirePermission('files.upload'), express.json({ limit: '32mb' }), async (req, res, next) => {
    try {
      const { file_name, mime_type, content_base64, property_id } = req.body || {};
      if (!file_name || !content_base64) return res.status(400).json({ error: 'missing_fields', requestId: req.ctx.requestId });
      const buffer = Buffer.from(content_base64, 'base64');
      const row = await fileService.upload({
        tenantId:     req.ctx.tenantId,
        propertyId:   property_id || req.ctx.propertyId,
        fileName:     file_name,
        mimeType:     mime_type || 'application/octet-stream',
        buffer
      }, req.ctx);
      res.status(201).json({ ok: true, file: row, requestId: req.ctx.requestId });
    } catch (err) { next(err); }
  });

  // GET /api/files/:id - metadata only
  router.get('/:id', requirePermission('files.read'), async (req, res, next) => {
    try {
      const row = await fileService.metadata(req.params.id, req.ctx);
      if (!row) return res.status(404).json({ error: 'not_found', requestId: req.ctx.requestId });
      res.json({ ok: true, file: row, requestId: req.ctx.requestId });
    } catch (err) { next(err); }
  });

  // GET /api/files/:id/token - issue short-lived signed access token
  router.get('/:id/token', requirePermission('files.read'), async (req, res, next) => {
    try {
      const meta = await fileService.metadata(req.params.id, req.ctx);
      if (!meta) return res.status(404).json({ error: 'not_found', requestId: req.ctx.requestId });
      const token = fileService.signAccessToken(req.params.id, req.ctx, 300);
      res.json({ ok: true, token, expires_in_sec: 300, requestId: req.ctx.requestId });
    } catch (err) { next(err); }
  });

  // GET /api/files/:id/download - stream contents; needs token query or bearer
  router.get('/:id/download', async (req, res, next) => {
    try {
      // Two auth paths: bearer (already set req.user via outer chain) OR token query
      let ctx = req.ctx;
      if (!ctx || !ctx.tenantId) {
        // Bearer auth chain might not have run if route was hit anonymously with ?token=
        const t = req.query && req.query.token;
        if (!t) return res.status(401).json({ error: 'authentication_required' });
        const v = fileService.verifyAccessToken(t);
        if (!v.ok) return res.status(401).json({ error: 'invalid_token' });
        ctx = { tenantId: v.tenantId, propertyId: null, actorId: v.actorId, requestId: req.requestId };
      } else if (req.query && req.query.token) {
        // Token in query overrides bearer scope (useful for cross-origin embeds)
        const v = fileService.verifyAccessToken(req.query.token);
        if (!v.ok || v.tenantId !== ctx.tenantId) return res.status(401).json({ error: 'invalid_token' });
      }
      const d = await fileService.download(req.params.id, ctx);
      if (!d) return res.status(404).json({ error: 'not_found' });
      res.setHeader('Content-Type',  d.mimeType);
      res.setHeader('Content-Length', d.fileSize);
      res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(d.fileName) + '"');
      d.stream.on('error', (err) => next(err));
      d.stream.pipe(res);
    } catch (err) { next(err); }
  });

  // DELETE /api/files/:id - soft-delete
  router.delete('/:id', requirePermission('files.delete'), async (req, res, next) => {
    try {
      const r = await fileService.delete(req.params.id, req.ctx);
      res.json(Object.assign({ requestId: req.ctx.requestId }, r));
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { build };
