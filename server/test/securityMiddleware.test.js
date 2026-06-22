'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createApp } = require('../src/app');
const { securityHeaders, sanitizeJsonBody, verifyWebhookSignature, _nonceLru } = require('../src/middleware/security');
const express = require('express');

function reqResNext() {
  const headers = {};
  const res = {
    setHeader(k, v) { headers[k] = v; },
    status(s) { this.statusCode = s; return this; },
    json(o) { this._body = o; return this; }
  };
  const req = {};
  // Wrap mutable state so tests can read the LIVE values after the middleware
  // mutates them. Primitive captures don't see updates.
  const state = { nextCalled: false, nextErr: [] };
  const next = (e) => { state.nextCalled = true; if (e) state.nextErr.push(e); };
  return { req, res, next, headers,
    get nextCalled() { return state.nextCalled; },
    get nextErr()    { return state.nextErr; } };
}

test('securityHeaders sets the expected hardening headers', async () => {
  const app = createApp({ db: fx.makeFakeDb() });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/health/live');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.match(r.headers['strict-transport-security'], /max-age=63072000/);
    assert.match(r.headers['content-security-policy'], /default-src 'none'/);
  } finally { srv.close(); }
});

test('root-level /health/live + /health/ready exist and work', async () => {
  const app = createApp({ db: fx.makeFakeDb() });
  const { srv, url } = await fx.listen(app);
  try {
    const live  = await fx.fetchJson(url + '/health/live');
    const ready = await fx.fetchJson(url + '/health/ready');
    assert.equal(live.status,  200);
    assert.equal(ready.status, 200);
    assert.equal(ready.body.db, 'ok');
  } finally { srv.close(); }
});

test('sanitizeJsonBody trims string fields', () => {
  const mw = sanitizeJsonBody({ maxStringLen: 100, maxDepth: 3 });
  const ctx = reqResNext();
  ctx.req.body = { x: '  hello  ', y: ['  a ', ' b '] };
  mw(ctx.req, ctx.res, ctx.next);
  assert.equal(ctx.nextCalled, true);
  assert.equal(ctx.req.body.x, 'hello');
  assert.deepEqual(ctx.req.body.y, ['a', 'b']);
});

test('sanitizeJsonBody rejects strings over the cap', () => {
  const mw = sanitizeJsonBody({ maxStringLen: 5, maxDepth: 3 });
  const ctx = reqResNext();
  ctx.req.body = { x: 'hello world' };
  mw(ctx.req, ctx.res, ctx.next);
  assert.equal(ctx.nextCalled, true);
  assert.equal(ctx.nextErr.length, 1);
  assert.equal(ctx.nextErr[0].code, 'string_too_long');
});

test('sanitizeJsonBody rejects deeply-nested objects', () => {
  const mw = sanitizeJsonBody({ maxStringLen: 100, maxDepth: 2 });
  const ctx = reqResNext();
  ctx.req.body = { a: { b: { c: { d: 'too deep' } } } };
  mw(ctx.req, ctx.res, ctx.next);
  assert.equal(ctx.nextErr[0].code, 'payload_too_deep');
});

// ---- webhook signature verification ---------------------------------------

function makeSig(secret, ts, raw) {
  const h = crypto.createHmac('sha256', secret).update(ts + '.' + raw).digest('hex');
  return 't=' + ts + ',v1=' + h;
}

function exerciseVerify(headerVal, payload, opts = {}) {
  const mw = verifyWebhookSignature({ secretFor: () => 'topsecret', toleranceSec: opts.tol || 300 });
  const ctx = reqResNext();
  ctx.req.get = (k) => (String(k).toLowerCase() === 'x-qyrvia-signature') ? headerVal : null;
  ctx.req.body = payload;
  ctx.req.rawBody = JSON.stringify(payload);
  mw(ctx.req, ctx.res, ctx.next);
  return ctx;
}

test('verifyWebhookSignature passes on valid signature', () => {
  _nonceLru.clear();
  const ts = Math.floor(Date.now() / 1000);
  const payload = { event_type: 'demo.created', x: 1 };
  const header = makeSig('topsecret', ts, JSON.stringify(payload));
  const ctx = exerciseVerify(header, payload);
  assert.equal(ctx.nextCalled, true);
  assert.equal(ctx.nextErr.length, 0);
});

test('verifyWebhookSignature rejects malformed header', () => {
  _nonceLru.clear();
  const ctx = exerciseVerify('not a signature', {});
  assert.equal(ctx.res.statusCode, 401);
  assert.equal(ctx.res._body.error, 'signature_malformed');
});

test('verifyWebhookSignature rejects when timestamp out of tolerance', () => {
  _nonceLru.clear();
  const ts = Math.floor(Date.now() / 1000) - 10000;
  const payload = { x: 1 };
  const header = makeSig('topsecret', ts, JSON.stringify(payload));
  const ctx = exerciseVerify(header, payload);
  assert.equal(ctx.res.statusCode, 401);
  assert.equal(ctx.res._body.error, 'signature_expired');
});

test('verifyWebhookSignature rejects replay (same nonce twice)', () => {
  _nonceLru.clear();
  const ts = Math.floor(Date.now() / 1000);
  const payload = { x: 2 };
  const header = makeSig('topsecret', ts, JSON.stringify(payload));
  const a = exerciseVerify(header, payload);
  assert.equal(a.nextCalled, true);
  const b = exerciseVerify(header, payload);
  assert.equal(b.res.statusCode, 401);
  assert.equal(b.res._body.error, 'signature_replayed');
});

test('verifyWebhookSignature rejects wrong secret', () => {
  _nonceLru.clear();
  const ts = Math.floor(Date.now() / 1000);
  const payload = { x: 3 };
  const wrong = 't=' + ts + ',v1=' + ('a'.repeat(64));
  const ctx = exerciseVerify(wrong, payload);
  assert.equal(ctx.res.statusCode, 401);
  assert.equal(ctx.res._body.error, 'signature_mismatch');
});
