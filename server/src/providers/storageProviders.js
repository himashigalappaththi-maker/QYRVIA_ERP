'use strict';

/**
 * Storage provider abstraction.
 *
 * Every provider implements:
 *   { name,
 *     async upload({ key, buffer, mimeType }),
 *     async download(key) -> Stream,
 *     async delete(key) -> bool,
 *     async exists(key) -> bool,
 *     async signedUrl(key, ttlSec) -> string | null }
 *
 * Phase 4 ships three:
 *   - LocalProvider      (filesystem under STORAGE_ROOT) - production-ready
 *   - MemoryProvider     (in-process Map; tests only)
 *   - S3CompatibleProvider (Amazon S3, Cloudflare R2, MinIO) - production
 *     when @aws-sdk/client-s3 is installed; otherwise throws on construct.
 *
 * No provider-specific logic leaks into services. fileService keeps a map
 * { provider_name -> provider } and dispatches by row.storage_provider.
 */

const path     = require('path');
const fs       = require('fs/promises');
const fssync   = require('fs');
const crypto   = require('crypto');
const { Readable } = require('node:stream');

function buildLocalProvider({ root }) {
  if (!root) throw new Error('LocalProvider: root required');
  return {
    name: 'local',
    async upload({ key, buffer }) {
      const full = path.join(root, key);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, buffer);
      return { key, size: buffer.length };
    },
    async download(key) {
      const full = path.join(root, key);
      return fssync.createReadStream(full);
    },
    async delete(key) {
      const full = path.join(root, key);
      try { await fs.unlink(full); return true; }
      catch (err) { if (err.code === 'ENOENT') return false; throw err; }
    },
    async exists(key) {
      const full = path.join(root, key);
      try { await fs.access(full); return true; } catch { return false; }
    },
    async signedUrl() {
      // Local storage has no concept of a URL - return null, callers fall back
      // to the file_token JWT scheme via the file service.
      return null;
    }
  };
}

function buildMemoryProvider() {
  const blobs = new Map();
  return {
    name: 'memory',
    _blobs: blobs,
    async upload({ key, buffer }) { blobs.set(key, Buffer.from(buffer)); return { key, size: buffer.length }; },
    async download(key) {
      const buf = blobs.get(key);
      return Readable.from(buf || Buffer.alloc(0));
    },
    async delete(key) { return blobs.delete(key); },
    async exists(key) { return blobs.has(key); },
    async signedUrl() { return null; }
  };
}

function buildS3CompatibleProvider(opts = {}) {
  // Lazy-require @aws-sdk/client-s3 - operators install it only if needed.
  let S3, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, getSignedUrl;
  try {
    ({ S3, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3'));
    ({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'));
  } catch (e) {
    throw new Error('S3-compatible storage requires "@aws-sdk/client-s3" and "@aws-sdk/s3-request-presigner"');
  }
  const cfg = {
    region:        opts.region        || process.env.S3_REGION        || 'auto',
    endpoint:      opts.endpoint      || process.env.S3_ENDPOINT      || undefined,    // R2 / MinIO
    forcePathStyle:opts.forcePathStyle || process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: {
      accessKeyId:     opts.accessKeyId     || process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: opts.secretAccessKey || process.env.S3_SECRET_ACCESS_KEY
    }
  };
  if (!cfg.credentials.accessKeyId || !cfg.credentials.secretAccessKey) {
    throw new Error('S3-compatible storage requires S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY env vars');
  }
  const bucket = opts.bucket || process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3-compatible storage requires opts.bucket or S3_BUCKET env var');
  const client = new S3(cfg);
  return {
    name: opts.providerName || 's3',
    async upload({ key, buffer, mimeType }) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: mimeType }));
      return { key, size: buffer.length };
    },
    async download(key) {
      const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return resp.Body; // already a Readable
    },
    async delete(key) {
      try { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); return true; }
      catch (_) { return false; }
    },
    async exists(key) {
      try { await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; }
      catch (_) { return false; }
    },
    async signedUrl(key, ttlSec) {
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
      return getSignedUrl(client, cmd, { expiresIn: ttlSec || 300 });
    }
  };
}

module.exports = { buildLocalProvider, buildMemoryProvider, buildS3CompatibleProvider };
