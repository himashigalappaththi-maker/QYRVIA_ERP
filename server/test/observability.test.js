'use strict';

/**
 * Phase 32 - Observability hardening. Proves the metrics registry shape, that
 * slow queries log a SQL HASH (never the SQL text or params), that the logger
 * redaction strategy censors secrets, that RLS missing-context fires a metric +
 * security event, and that the instrumented pool never leaks SQL/params.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const pino = require('pino');

const { buildObservabilityMetrics } = require('../src/observability/metrics');
const { buildSlowQueryDetector, sqlHash } = require('../src/observability/slowQuery');
const { buildObservability } = require('../src/observability');
const { instrumentPool } = require('../src/observability/instrumentedPool');
const { buildMetricsEngine } = require('../src/platform/observability/MetricsEngine');

const HEX16 = /^[0-9a-f]{16}$/;

// A logger that records every (record, msg) pair it is asked to emit.
function captureLogger() {
  const lines = [];
  const push = (level) => (record, msg) => lines.push({ level, record, msg });
  return {
    lines,
    info: push('info'), warn: push('warn'), error: push('error'),
    fatal: push('fatal'), debug: push('debug'),
    child() { return this; }
  };
}

// ---- metrics registry ------------------------------------------------------
test('metrics registry emits counters + histograms with low-cardinality labels', () => {
  const m = buildObservabilityMetrics({ engine: buildMetricsEngine() });
  m.httpRequest('GET', '/api/pms/rooms', 200, 12.5);
  m.httpRequest('GET', '/api/pms/rooms', 200, 7.25);
  m.dbQuery('select', 3.1);
  m.dbQuery('insert', 250, { slowBucket: 'warn_gt_100ms' });
  m.business('reservation');
  m.rls('tenant_switch');

  const snap = m.snapshot();
  assert.equal(snap.counters['http_requests_total{method=GET,route=/api/pms/rooms,status=200}'], 2);
  assert.equal(snap.counters['db_queries_total{op=select}'], 1);
  assert.equal(snap.counters['db_slow_queries_total{bucket=warn_gt_100ms}'], 1);
  assert.equal(snap.counters['business_events_total{event=reservation}'], 1);
  assert.equal(snap.counters['rls_events_total{event=tenant_switch}'], 1);

  const httpTiming = snap.timings['http_request_ms{method=GET,route=/api/pms/rooms}'];
  assert.equal(httpTiming.count, 2);
  assert.ok(httpTiming.avg > 0 && httpTiming.max >= httpTiming.avg);

  const prom = m.prometheus();
  assert.match(prom, /qyrvia_http_requests_total\{method="GET",route="\/api\/pms\/rooms",status="200"\} 2/);
  assert.match(prom, /qyrvia_http_active_requests 0/);
});

// ---- slow query: hash not text ---------------------------------------------
test('slow query logs SQL hash + duration bucket, never the SQL text or params', () => {
  const log = captureLogger();
  const det = buildSlowQueryDetector({ logger: log });

  // Fast query is below threshold -> no record, no log.
  assert.equal(det.record({ sql: 'SELECT 1', ms: 5 }), null);
  assert.equal(log.lines.length, 0);

  const SECRET = 'p@ssw0rd-leak-me-not';
  const SQL = `SELECT * FROM users WHERE password_hash = '${SECRET}'`;
  const rec = det.record({ sql: SQL, ms: 640, caller: 'identityRepo.findUser' });

  assert.equal(rec.bucket, 'high_gt_500ms');
  assert.match(rec.sql_hash, HEX16);
  assert.equal(rec.sql_hash, sqlHash(SQL));
  assert.equal(rec.duration_ms, 640);
  assert.equal(rec.caller, 'identityRepo.findUser');
  assert.equal(rec.sql, undefined); // structural guarantee: no raw SQL field

  // The full emitted payload must contain neither the SQL text nor the secret.
  const blob = JSON.stringify(log.lines);
  assert.ok(!blob.includes(SECRET), 'secret literal leaked into slow-query log');
  assert.ok(!blob.includes('FROM users WHERE'), 'raw SQL leaked into slow-query log');
  assert.ok(blob.includes(rec.sql_hash), 'expected the SQL hash in the log');

  // Threshold classification boundaries.
  assert.equal(det.classify(99), null);
  assert.equal(det.classify(100), 'warn_gt_100ms');
  assert.equal(det.classify(500), 'high_gt_500ms');
  assert.equal(det.classify(1000), 'critical_gt_1s');
});

// ---- logger redaction ------------------------------------------------------
test('logger redaction censors secrets (passwords, tokens, auth headers, cookies)', () => {
  const chunks = [];
  const sink = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
  // Mirror the production redact contract from src/config/logger.js.
  const log = pino({
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.secret', '*.token'],
      censor: '[REDACTED]'
    }
  }, sink);

  log.info({
    user: { name: 'alice', password: 'hunter2' },
    creds: { token: 'eyJhbGciOi.secret.value', secret: 'top-secret' },
    req: { headers: { authorization: 'Bearer abc.def.ghi', cookie: 'sid=deadbeef' } }
  }, 'login');

  const out = chunks.join('');
  assert.ok(out.includes('[REDACTED]'), 'expected redaction marker');
  assert.ok(!out.includes('hunter2'), 'password leaked');
  assert.ok(!out.includes('top-secret'), 'secret leaked');
  assert.ok(!out.includes('eyJhbGciOi'), 'token leaked');
  assert.ok(!out.includes('Bearer abc.def.ghi'), 'authorization header leaked');
  assert.ok(!out.includes('sid=deadbeef'), 'cookie leaked');
  assert.ok(out.includes('alice'), 'non-secret field should survive');
});

// ---- RLS missing context ---------------------------------------------------
test('RLS missing-context fires a counter + a security event + an error log', () => {
  const log = captureLogger();
  const obs = buildObservability({ logger: log, metrics: buildMetricsEngine() });

  obs.rls.contextSet('tenant');       // success path
  obs.rls.contextSet('property');
  const evt = obs.rls.missingContext('tenant');

  assert.equal(evt.evt, 'db.missing_tenant_context');
  assert.equal(evt.security, true);
  assert.equal(evt.severity, 'error');

  const snap = obs.snapshot();
  assert.equal(snap.counters['rls_events_total{event=tenant_switch}'], 1);
  assert.equal(snap.counters['rls_events_total{event=property_switch}'], 1);
  assert.equal(snap.counters['rls_events_total{event=context_failure}'], 1);
  assert.equal(snap.counters['security_events_total{category=db,event=db.missing_tenant_context}'], 1);

  const logged = log.lines.find((l) => l.record && l.record.evt === 'db.missing_tenant_context');
  assert.ok(logged, 'missing-context should be logged');
  assert.equal(logged.level, 'error');
});

// ---- instrumented pool: metrics without leaking SQL ------------------------
test('instrumented pool records query metrics and slow queries without leaking SQL/params', async () => {
  const log = captureLogger();
  const obs = buildObservability({ logger: log, metrics: buildMetricsEngine() });

  const SECRET_PARAM = 'caller-supplied-secret-9f3a';
  const fakePool = {
    flagProp: 42,
    async query(sql, params) {
      // Slow only for the targeted statement; fast otherwise.
      if (/refresh_tokens/.test(sql)) await new Promise((r) => setTimeout(r, 130));
      return { rows: [], rowCount: 0, _params: params };
    },
    async connect() {
      return { query: async (sql) => ({ rows: [{ ok: sql.length }] }), release() {} };
    }
  };

  const pool = instrumentPool(fakePool, obs);

  // Transparent pass-through of non-instrumented members.
  assert.equal(pool.flagProp, 42);

  // Fast query -> op counter, no slow log.
  await pool.query('SELECT id FROM rooms WHERE tenant_id = $1', ['t-1']);
  assert.equal(obs.snapshot().counters['db_queries_total{op=select}'], 1);
  assert.equal(log.lines.length, 0);

  // Slow query carrying a secret param + secret-looking SQL.
  const SLOW_SQL = `SELECT * FROM refresh_tokens WHERE token_hash = $1`;
  await pool.query(SLOW_SQL, [SECRET_PARAM]);

  const snap = obs.snapshot();
  assert.equal(snap.counters['db_queries_total{op=select}'], 2);
  assert.ok(snap.counters['db_slow_queries_total{bucket=warn_gt_100ms}'] >= 1);

  const blob = JSON.stringify(log.lines);
  assert.ok(log.lines.length >= 1, 'slow query should have logged');
  assert.ok(!blob.includes(SECRET_PARAM), 'param value leaked into logs');
  assert.ok(!blob.includes('refresh_tokens'), 'raw SQL leaked into logs');
  assert.ok(/[0-9a-f]{16}/.test(blob), 'expected a SQL hash in the log');

  // connect() returns an instrumented client whose queries are also counted.
  const client = await pool.connect();
  const r = await client.query('INSERT INTO audit_events DEFAULT VALUES');
  assert.equal(r.rows[0].ok, 'INSERT INTO audit_events DEFAULT VALUES'.length);
  assert.equal(obs.snapshot().counters['db_queries_total{op=insert}'], 1);
  client.release();
});

// ---- instrumentation must not change query behavior ------------------------
test('instrumented pool is transparent: resolves values and propagates errors', async () => {
  const obs = buildObservability({ logger: captureLogger(), metrics: buildMetricsEngine() });
  const boom = new Error('db exploded');
  const pool = instrumentPool({
    async query(sql) { if (/fail/.test(sql)) throw boom; return { rows: [{ n: 1 }] }; }
  }, obs);

  assert.deepEqual((await pool.query('SELECT 1')).rows, [{ n: 1 }]);
  await assert.rejects(() => pool.query('SELECT fail'), boom);
  // The failed query is still accounted for.
  assert.equal(obs.snapshot().counters['db_queries_total{op=select}'], 2);
});
