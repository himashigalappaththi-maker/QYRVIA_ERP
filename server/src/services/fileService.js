'use strict';

/**
 * File storage service.
 *
 * Phase 3: local filesystem provider rooted at STORAGE_ROOT.
 * Pluggable: each provider implements { putBuffer, getStream, deleteKey } and
 * we look it up by name. Tests can pass a memory provider via deps.providers.
 *
 *   upload({ tenantId, propertyId, fileName, mimeType, buffer, uploadedBy }) -> file row
 *   download(id, ctx) -> { stream, mimeType, fileName, fileSize }
 *   metadata(id, ctx) -> file row
 *   delete(id, ctx) -> { ok }
 *   signAccessToken(id, ctx, ttlSec) -> token  (short-lived JWT containing file id + tenant)
 *   verifyAccessToken(token) -> { ok, fileId, tenantId } | { ok:false }
 *
 * Audit: every upload + delete writes a domain event.
 */

const path   = require('path');
const fs     = require('fs/promises');
const fssync = require('fs');
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const env    = require('../config/env');
const { makeEvent } = require('../core/event');
const eventBus      = require('../core/eventBus');
const logger        = require('../config/logger');

const FILE_TOKEN_TTL = 300; // 5 minutes

function defaultLocalProvider(root) {
  return {
    name: 'local',
    async putBuffer({ key, buffer }) {
      const full = path.join(root, key);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, buffer);
      return { stored: true };
    },
    getStream(key) {
      const full = path.join(root, key);
      return fssync.createReadStream(full);
    },
    async deleteKey(key) {
      const full = path.join(root, key);
      try { await fs.unlink(full); return true; }
      catch (err) { if (err.code === 'ENOENT') return false; throw err; }
    }
  };
}

function buildFileService({ repo, providers, storageRoot }) {
  if (!repo) throw new Error('buildFileService: repo required');
  const root = storageRoot || process.env.STORAGE_ROOT || path.join(process.cwd(), 'storage');
  const provs = providers || { local: defaultLocalProvider(root) };

  function _pickProvider() {
    // Phase 3: local only
    return provs.local;
  }

  function _keyFor(tenantId, sha256, fileName) {
    // tenant-isolated paths; sha-prefixed to enable simple dedupe later
    return `${tenantId}/${sha256.slice(0,2)}/${sha256.slice(2,4)}/${sha256}-${path.basename(fileName)}`;
  }

  async function upload({ tenantId, propertyId, fileName, mimeType, buffer, uploadedBy }, ctx) {
    if (!tenantId) throw new Error('upload: tenantId required');
    if (!Buffer.isBuffer(buffer)) throw new Error('upload: buffer required');
    if (!fileName) throw new Error('upload: fileName required');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const provider = _pickProvider();
    const key = _keyFor(tenantId, sha256, fileName);
    await provider.putBuffer({ key, buffer });
    const row = await repo.insertFile({
      tenant_id:        tenantId,
      property_id:      propertyId || null,
      file_name:        fileName,
      mime_type:        mimeType || 'application/octet-stream',
      file_size:        buffer.length,
      sha256:           sha256,
      storage_provider: provider.name,
      storage_key:      key,
      uploaded_by:      uploadedBy || (ctx && ctx.actorId) || null
    });
    if (ctx && ctx.requestId) {
      try {
        await eventBus.publish(makeEvent({
          type:          'file.uploaded',
          aggregateType: 'file',
          aggregateId:   row.id,
          payload:       { file_name: fileName, mime_type: mimeType, file_size: buffer.length, sha256 },
          ctx
        }));
      } catch (e) { logger.error({ err: e }, '[files] audit publish failed'); }
    }
    return row;
  }

  async function metadata(id, ctx) {
    if (!ctx || !ctx.tenantId) return null;
    return repo.findFileById(ctx.tenantId, id);
  }

  async function download(id, ctx) {
    if (!ctx || !ctx.tenantId) return null;
    const row = await repo.findFileById(ctx.tenantId, id);
    if (!row || row.status === 'deleted') return null;
    const provider = provs[row.storage_provider] || provs.local;
    return {
      stream:    provider.getStream(row.storage_key),
      mimeType:  row.mime_type,
      fileName:  row.file_name,
      fileSize:  row.file_size
    };
  }

  async function deleteFile(id, ctx) {
    if (!ctx || !ctx.tenantId) return { ok: false, error: 'tenant_required' };
    const row = await repo.findFileById(ctx.tenantId, id);
    if (!row) return { ok: false, error: 'not_found' };
    const provider = provs[row.storage_provider] || provs.local;
    try { await provider.deleteKey(row.storage_key); } catch (e) { logger.warn({ err: e }, '[files] provider delete failed'); }
    await repo.softDeleteFile(ctx.tenantId, id);
    try {
      await eventBus.publish(makeEvent({
        type:          'file.deleted',
        aggregateType: 'file',
        aggregateId:   id,
        payload:       { file_name: row.file_name },
        ctx
      }));
    } catch (e) { logger.error({ err: e }, '[files] audit publish failed'); }
    return { ok: true };
  }

  function signAccessToken(fileId, ctx, ttlSec) {
    if (!ctx || !ctx.tenantId) throw new Error('signAccessToken: ctx.tenantId required');
    return jwt.sign(
      { f: fileId, t: ctx.tenantId, u: ctx.actorId || null },
      env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: ttlSec || FILE_TOKEN_TTL, issuer: 'qyrvia-file' }
    );
  }

  function verifyAccessToken(token) {
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'qyrvia-file' });
      return { ok: true, fileId: decoded.f, tenantId: decoded.t, actorId: decoded.u || null };
    } catch (_) {
      return { ok: false };
    }
  }

  return { upload, metadata, download, delete: deleteFile, signAccessToken, verifyAccessToken };
}

module.exports = { buildFileService, defaultLocalProvider };
