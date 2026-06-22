'use strict';

const fx = require('./_fixtures');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { buildFileService } = require('../src/services/fileService');
const eventBus             = require('../src/core/eventBus');

const CTX       = { requestId: 'rq-f', tenantId: fx.TENANT_A, propertyId: null, actorId: fx.USER_ID };
const CTX_OTHER = Object.assign({}, CTX, { tenantId: fx.TENANT_B });

function memoryProvider() {
  const blobs = new Map();
  return {
    name: 'local',
    blobs,
    async putBuffer({ key, buffer }) { blobs.set(key, Buffer.from(buffer)); return { stored: true }; },
    getStream(key) {
      const { Readable } = require('node:stream');
      const buf = blobs.get(key);
      return Readable.from(buf || Buffer.alloc(0));
    },
    async deleteKey(key) { return blobs.delete(key); }
  };
}

beforeEach(() => { eventBus.reset(); });

test('upload persists metadata + writes blob + emits file.uploaded', async () => {
  const r  = fx.makeFakeRepos();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  const prov = memoryProvider();
  const svc = buildFileService({ repo: r.fileRepo, providers: { local: prov } });
  const row = await svc.upload({
    tenantId: fx.TENANT_A, fileName: 'invoice.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from('hello world')
  }, CTX);
  assert.equal(row.tenant_id, fx.TENANT_A);
  assert.equal(row.file_name, 'invoice.pdf');
  assert.equal(row.file_size, 11);
  assert.equal(prov.blobs.size, 1, 'blob written to provider');
  assert.ok(db.auditRows.find(x => x.event_type === 'file.uploaded'));
});

test('tenant isolation: tenant B cannot read tenant A files', async () => {
  const r  = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildFileService({ repo: r.fileRepo, providers: { local: memoryProvider() } });
  const row = await svc.upload({
    tenantId: fx.TENANT_A, fileName: 'a.txt', mimeType: 'text/plain',
    buffer: Buffer.from('A only')
  }, CTX);
  const meta = await svc.metadata(row.id, CTX_OTHER);
  assert.equal(meta, null);
});

test('download streams content', async () => {
  const r  = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildFileService({ repo: r.fileRepo, providers: { local: memoryProvider() } });
  const row = await svc.upload({
    tenantId: fx.TENANT_A, fileName: 'x.txt', mimeType: 'text/plain',
    buffer: Buffer.from('content')
  }, CTX);
  const d = await svc.download(row.id, CTX);
  assert.equal(d.mimeType, 'text/plain');
  // read stream
  const chunks = [];
  for await (const chunk of d.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'content');
});

test('signAccessToken + verifyAccessToken round-trip', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildFileService({ repo: r.fileRepo, providers: { local: memoryProvider() } });
  const row = await svc.upload({
    tenantId: fx.TENANT_A, fileName: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a')
  }, CTX);
  const token = svc.signAccessToken(row.id, CTX, 60);
  const v = svc.verifyAccessToken(token);
  assert.equal(v.ok, true);
  assert.equal(v.fileId, row.id);
  assert.equal(v.tenantId, fx.TENANT_A);
});

test('delete soft-deletes the record and emits file.deleted', async () => {
  const r  = fx.makeFakeRepos();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  const svc = buildFileService({ repo: r.fileRepo, providers: { local: memoryProvider() } });
  const row = await svc.upload({
    tenantId: fx.TENANT_A, fileName: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a')
  }, CTX);
  const d = await svc.delete(row.id, CTX);
  assert.equal(d.ok, true);
  const reread = await svc.metadata(row.id, CTX);
  assert.equal(reread.status, 'deleted');
  assert.ok(db.auditRows.find(x => x.event_type === 'file.deleted'));
});

test('delete on unknown id -> not_found', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildFileService({ repo: r.fileRepo, providers: { local: memoryProvider() } });
  const d = await svc.delete('nope', CTX);
  assert.equal(d.ok, false);
  assert.equal(d.error, 'not_found');
});

test('upload computes deterministic sha256 of content', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildFileService({ repo: r.fileRepo, providers: { local: memoryProvider() } });
  const a = await svc.upload({ tenantId: fx.TENANT_A, fileName: 'a', mimeType: 't', buffer: Buffer.from('xxx') }, CTX);
  const b = await svc.upload({ tenantId: fx.TENANT_A, fileName: 'b', mimeType: 't', buffer: Buffer.from('xxx') }, CTX);
  assert.equal(a.sha256, b.sha256, 'identical content -> identical sha256');
});
