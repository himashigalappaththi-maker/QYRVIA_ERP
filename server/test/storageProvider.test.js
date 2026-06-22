'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os   = require('node:os');
const path = require('node:path');
const fs   = require('node:fs/promises');

const { buildLocalProvider, buildMemoryProvider, buildS3CompatibleProvider } = require('../src/providers/storageProviders');

async function consume(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

test('memory provider: full round-trip', async () => {
  const p = buildMemoryProvider();
  await p.upload({ key: 'k1', buffer: Buffer.from('hello'), mimeType: 'text/plain' });
  assert.equal(await p.exists('k1'), true);
  const buf = await consume(await p.download('k1'));
  assert.equal(buf.toString(), 'hello');
  assert.equal(await p.delete('k1'), true);
  assert.equal(await p.exists('k1'), false);
});

test('local provider: full round-trip on a tmp dir', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qy-stor-'));
  try {
    const p = buildLocalProvider({ root });
    await p.upload({ key: 'sub/k.txt', buffer: Buffer.from('hi'), mimeType: 'text/plain' });
    assert.equal(await p.exists('sub/k.txt'), true);
    const buf = await consume(await p.download('sub/k.txt'));
    assert.equal(buf.toString(), 'hi');
    assert.equal(await p.delete('sub/k.txt'), true);
    assert.equal(await p.exists('sub/k.txt'), false);
  } finally {
    try { await fs.rm(root, { recursive: true, force: true }); } catch (_) {}
  }
});

test('signedUrl: local + memory return null (no remote URL)', async () => {
  const a = buildMemoryProvider();
  assert.equal(await a.signedUrl('any', 60), null);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qy-stor-'));
  try {
    const b = buildLocalProvider({ root });
    assert.equal(await b.signedUrl('any', 60), null);
  } finally {
    try { await fs.rm(root, { recursive: true, force: true }); } catch (_) {}
  }
});

test('S3CompatibleProvider throws if @aws-sdk/client-s3 not installed', () => {
  // The test environment has not installed the optional dep, so the
  // constructor MUST throw a clear error.
  assert.throws(() => buildS3CompatibleProvider({ bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }),
    /@aws-sdk\/client-s3/);
});

test('LocalProvider requires root', () => {
  assert.throws(() => buildLocalProvider({}), /root required/);
});

test('memory.delete on missing key returns false', async () => {
  const p = buildMemoryProvider();
  assert.equal(await p.delete('nope'), false);
});

test('local.delete on missing key returns false (ENOENT swallowed)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qy-stor-'));
  try {
    const p = buildLocalProvider({ root });
    assert.equal(await p.delete('does-not-exist'), false);
  } finally {
    try { await fs.rm(root, { recursive: true, force: true }); } catch (_) {}
  }
});
