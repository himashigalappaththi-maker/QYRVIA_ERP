'use strict';

/**
 * Phase 61 — production hardening tests.
 * Covers: env validation gate, CORS middleware, health endpoints,
 *         trust proxy configuration.
 * No real database connections. No network I/O.
 */

process.env.NODE_ENV   = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/qyrvia_test';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'phase61-test-jwt-secret-at-least-32-characters-long';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// validateProductionEnv
// ---------------------------------------------------------------------------

const {
  validateProductionEnv,
  looksLikePlaceholder,
  looksLikeLocalhost,
} = require('../src/config/envValidation');

function makeEnv(overrides = {}) {
  return Object.assign({
    DATABASE_URL:                      'postgresql://user:pass@prod.db:5432/qyrvia',
    JWT_SECRET:                        'a'.repeat(64),
    APP_BASE_URL:                      'https://app.qyrvia.com',
    PAYMENT_PROVIDER:                  'stripe',
    QYRVIA_NOTIFICATION_ENCRYPTION_KEY: '',
    SMTP_HOST:                         '',
    RESEND_API_KEY:                    '',
    CHANNEL_OTA_ACTIVATIONS:           '',
    CHANNEL_CREDENTIAL_KEY:            '',
    CORS_ORIGIN:                       'https://app.qyrvia.com',
  }, overrides);
}

describe('validateProductionEnv', () => {
  it('passes a fully valid production config', () => {
    const { errors, warnings } = validateProductionEnv(makeEnv());
    assert.deepEqual(errors, []);
  });

  it('rejects missing JWT_SECRET', () => {
    const { errors } = validateProductionEnv(makeEnv({ JWT_SECRET: '' }));
    assert.ok(errors.some((e) => e.includes('JWT_SECRET')), 'expect JWT_SECRET error');
  });

  it('rejects placeholder JWT_SECRET', () => {
    const { errors } = validateProductionEnv(makeEnv({ JWT_SECRET: 'replace-me-with-a-long-random-string-at-least-64' }));
    assert.ok(errors.some((e) => e.includes('placeholder')), 'expect placeholder error');
  });

  it('warns when JWT_SECRET < 64 chars', () => {
    const { errors, warnings } = validateProductionEnv(makeEnv({ JWT_SECRET: 'a'.repeat(32) }));
    assert.deepEqual(errors, [], 'no errors for 32-char JWT_SECRET (length is a warning)');
    assert.ok(warnings.some((w) => w.includes('JWT_SECRET')), 'expect JWT_SECRET length warning');
  });

  it('rejects localhost APP_BASE_URL', () => {
    const { errors } = validateProductionEnv(makeEnv({ APP_BASE_URL: 'http://localhost:3001' }));
    assert.ok(errors.some((e) => e.includes('APP_BASE_URL')), 'expect localhost error');
  });

  it('rejects 127.0.0.1 APP_BASE_URL', () => {
    const { errors } = validateProductionEnv(makeEnv({ APP_BASE_URL: 'http://127.0.0.1:3001' }));
    assert.ok(errors.some((e) => e.includes('APP_BASE_URL')), 'expect 127.0.0.1 error');
  });

  it('rejects PAYMENT_PROVIDER=mock', () => {
    const { errors } = validateProductionEnv(makeEnv({ PAYMENT_PROVIDER: 'mock' }));
    assert.ok(errors.some((e) => e.includes('PAYMENT_PROVIDER')), 'expect mock payment error');
  });

  it('rejects PAYMENT_PROVIDER missing', () => {
    const { errors } = validateProductionEnv(makeEnv({ PAYMENT_PROVIDER: '' }));
    assert.ok(errors.some((e) => e.includes('PAYMENT_PROVIDER')), 'expect empty payment error');
  });

  it('rejects malformed QYRVIA_NOTIFICATION_ENCRYPTION_KEY when SMTP is configured', () => {
    const { errors } = validateProductionEnv(makeEnv({
      SMTP_HOST: 'smtp.example.com',
      QYRVIA_NOTIFICATION_ENCRYPTION_KEY: 'tooshort',
    }));
    assert.ok(errors.some((e) => e.includes('QYRVIA_NOTIFICATION_ENCRYPTION_KEY')), 'expect key length error');
  });

  it('accepts base64 44-char notification key', () => {
    const key44 = Buffer.alloc(32).toString('base64'); // 44 chars
    const { errors } = validateProductionEnv(makeEnv({
      SMTP_HOST: 'smtp.example.com',
      QYRVIA_NOTIFICATION_ENCRYPTION_KEY: key44,
    }));
    assert.ok(!errors.some((e) => e.includes('QYRVIA_NOTIFICATION_ENCRYPTION_KEY')), 'no key error for 44-char base64');
  });

  it('warns when OTA activations set without credential key', () => {
    const { warnings } = validateProductionEnv(makeEnv({
      CHANNEL_OTA_ACTIVATIONS: '{"expedia":{"enabled":true}}',
      CHANNEL_CREDENTIAL_KEY:  '',
    }));
    assert.ok(warnings.some((w) => w.includes('CHANNEL_OTA_ACTIVATIONS')), 'expect OTA credential warning');
  });

  it('warns when CORS_ORIGIN is not set', () => {
    const { warnings } = validateProductionEnv(makeEnv({ CORS_ORIGIN: '' }));
    assert.ok(warnings.some((w) => w.includes('CORS_ORIGIN')), 'expect CORS_ORIGIN warning');
  });

  it('no CORS warning when CORS_ORIGIN is set', () => {
    const { warnings } = validateProductionEnv(makeEnv({ CORS_ORIGIN: 'https://app.qyrvia.com' }));
    assert.ok(!warnings.some((w) => w.includes('CORS_ORIGIN')), 'no CORS warning when origin set');
  });
});

describe('looksLikePlaceholder', () => {
  it('detects common placeholders', () => {
    assert.ok(looksLikePlaceholder('replace-me'));
    assert.ok(looksLikePlaceholder('changeme'));
    assert.ok(looksLikePlaceholder('your_secret'));
    assert.ok(looksLikePlaceholder('REPLACE-ME-WITH-A-LONG-RANDOM-STRING'));
  });
  it('passes real secrets', () => {
    assert.ok(!looksLikePlaceholder('X7k2mPqRjN9wLvHsYcBtFaEd3gUzAmVnOe'));
  });
});

describe('looksLikeLocalhost', () => {
  it('detects localhost variants', () => {
    assert.ok(looksLikeLocalhost('http://localhost:3001'));
    assert.ok(looksLikeLocalhost('http://127.0.0.1:3001'));
    assert.ok(looksLikeLocalhost('http://[::1]:3001'));
  });
  it('passes production URLs', () => {
    assert.ok(!looksLikeLocalhost('https://app.qyrvia.com'));
    assert.ok(!looksLikeLocalhost('https://api.example.com:443'));
  });
  it('handles empty/invalid URL safely', () => {
    assert.ok(!looksLikeLocalhost(''));
    assert.ok(!looksLikeLocalhost('not-a-url'));
  });
});

// ---------------------------------------------------------------------------
// corsMiddleware
// ---------------------------------------------------------------------------

const { corsMiddleware } = require('../src/middleware/security');

function makeCorsReq(origin) {
  return { get: (h) => (h === 'Origin' ? origin : null), method: 'GET' };
}

function makeCorsRes() {
  const h = {};
  let code = null;
  let ended = false;
  return {
    headers: h,
    code: () => code,
    ended: () => ended,
    setHeader: (k, v) => { h[k] = v; },
    status: (c) => { code = c; return { end: () => { ended = true; } }; },
  };
}

describe('corsMiddleware', () => {
  it('throws when no origin provided', () => {
    assert.throws(() => corsMiddleware(), /origin is required/);
  });

  it('sets CORS headers for matching origin', (_, done) => {
    const mw = corsMiddleware({ origin: 'https://app.qyrvia.com' });
    const req = makeCorsReq('https://app.qyrvia.com');
    const res = makeCorsRes();
    mw(req, res, () => {
      assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://app.qyrvia.com');
      assert.equal(res.headers['Vary'], 'Origin');
      assert.equal(res.headers['Access-Control-Allow-Credentials'], 'true');
      done();
    });
  });

  it('does not set CORS headers for non-matching origin', (_, done) => {
    const mw = corsMiddleware({ origin: 'https://app.qyrvia.com' });
    const req = makeCorsReq('https://evil.com');
    const res = makeCorsRes();
    mw(req, res, () => {
      assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
      done();
    });
  });

  it('does not set CORS headers when Origin header is absent', (_, done) => {
    const mw = corsMiddleware({ origin: 'https://app.qyrvia.com' });
    const req = makeCorsReq(null);
    const res = makeCorsRes();
    mw(req, res, () => {
      assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
      done();
    });
  });

  it('handles OPTIONS preflight with 204 and no next() call', () => {
    const mw = corsMiddleware({ origin: 'https://app.qyrvia.com' });
    const req = { get: () => 'https://app.qyrvia.com', method: 'OPTIONS' };
    const res = makeCorsRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(res.code(), 204,  'status must be 204');
    assert.equal(res.ended(), true, 'response must end');
    assert.equal(nextCalled, false, 'next() must not be called for OPTIONS');
  });

  it('does not emit wildcard Access-Control-Allow-Origin', (_, done) => {
    const mw = corsMiddleware({ origin: 'https://app.qyrvia.com' });
    const req = makeCorsReq('https://app.qyrvia.com');
    const res = makeCorsRes();
    mw(req, res, () => {
      assert.notEqual(res.headers['Access-Control-Allow-Origin'], '*', 'wildcard must never be emitted');
      done();
    });
  });
});

// ---------------------------------------------------------------------------
// Health endpoints via createApp
// ---------------------------------------------------------------------------

const http = require('node:http');
const { createApp } = require('../src/app');

function request(app, method, path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(body || '{}') });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

describe('health endpoints', () => {
  it('GET /health/live returns 200 ok', async () => {
    const db = { ping: async () => true, insertAuditEvent: async () => {} };
    const app = createApp({ db });
    const { status, body } = await request(app, 'GET', '/health/live');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
  });

  it('GET /health/ready returns 200 when DB ping succeeds', async () => {
    const db = { ping: async () => true, insertAuditEvent: async () => {} };
    const app = createApp({ db });
    const { status, body } = await request(app, 'GET', '/health/ready');
    assert.equal(status, 200);
    assert.equal(body.db, 'ok');
  });

  it('GET /health/ready returns 503 when DB ping fails', async () => {
    const db = { ping: async () => false, insertAuditEvent: async () => {} };
    const app = createApp({ db });
    const { status, body } = await request(app, 'GET', '/health/ready');
    assert.equal(status, 503);
    assert.equal(body.db, 'down');
  });

  it('GET /health/ready returns 503 when DB ping throws', async () => {
    const db = { ping: async () => { throw new Error('pool error'); }, insertAuditEvent: async () => {} };
    const app = createApp({ db });
    const { status, body } = await request(app, 'GET', '/health/ready');
    assert.equal(status, 503);
    assert.equal(body.db, 'down');
  });
});

// ---------------------------------------------------------------------------
// Trust proxy configuration
// ---------------------------------------------------------------------------

describe('trust proxy configuration', () => {
  it('defaults to numeric 1 when TRUST_PROXY="1"', () => {
    const app = createApp({ _trustProxy: '1', db: { ping: async () => true, insertAuditEvent: async () => {} } });
    assert.equal(app.get('trust proxy'), 1, 'string "1" must be parsed to number 1');
  });

  it('resolves "false" to boolean false', () => {
    const app = createApp({ _trustProxy: 'false', db: { ping: async () => true, insertAuditEvent: async () => {} } });
    assert.equal(app.get('trust proxy'), false);
  });

  it('resolves string "2" to number 2', () => {
    const app = createApp({ _trustProxy: '2', db: { ping: async () => true, insertAuditEvent: async () => {} } });
    assert.equal(app.get('trust proxy'), 2);
  });

  it('passes through string values like "loopback"', () => {
    const app = createApp({ _trustProxy: 'loopback', db: { ping: async () => true, insertAuditEvent: async () => {} } });
    assert.equal(app.get('trust proxy'), 'loopback');
  });
});
