'use strict';

/**
 * Phase 61 — P61-H2: focused shutdown factory tests.
 * No real server, no real database, no network I/O.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildShutdown, safeErrMeta } = require('../src/lifecycle/shutdown');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLog() {
  const calls = [];
  return {
    calls,
    dump: () => JSON.stringify(calls),
    info:  (...a) => calls.push(['info',  ...a]),
    warn:  (...a) => calls.push(['warn',  ...a]),
    error: (...a) => calls.push(['error', ...a]),
    fatal: (...a) => calls.push(['fatal', ...a]),
  };
}

function makeServer({ errOnClose = null, syncThrow = null, fireCallbackTwice = false } = {}) {
  const counts = { close: 0, cbFired: 0 };
  return {
    counts,
    close(cb) {
      counts.close++;
      if (syncThrow) throw syncThrow;
      const fire = () => { counts.cbFired++; if (cb) cb(errOnClose); };
      process.nextTick(fire);
      if (fireCallbackTwice) process.nextTick(fire);
    },
  };
}

function makeHangingServer() {
  return { close(_cb) { /* callback never called */ } };
}

function makeFakeTimers() {
  const timers = new Map();
  let _counter = 0;
  return {
    set:        (fn, ms) => { const id = ++_counter; timers.set(id, { fn, ms, cleared: false }); return id; },
    clear:      (id)     => { if (timers.has(id)) timers.get(id).cleared = true; },
    fire:       (id)     => { const t = timers.get(id); if (t && !t.cleared) t.fn(); },
    wasCleared: (id)     => timers.has(id) && timers.get(id).cleared,
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// safeErrMeta
// ---------------------------------------------------------------------------

describe('safeErrMeta', () => {
  it('includes only name and whitelisted code', () => {
    const err = Object.assign(new Error('postgresql://admin:secret@prod/db'), { code: 'ECONNREFUSED' });
    const m = safeErrMeta(err);
    assert.equal(m.name, 'Error', 'name preserved');
    assert.equal(m.code, 'ECONNREFUSED', 'whitelisted code preserved');
    assert.ok(!('message' in m), 'message must be absent');
    assert.ok(!('stack'   in m), 'stack must be absent');
  });

  it('omits non-whitelisted code', () => {
    const m = safeErrMeta(Object.assign(new Error('x'), { code: 'CUSTOM_INTERNAL_CODE' }));
    assert.ok(!('code' in m), 'non-whitelisted code must be absent');
  });

  it('handles non-Error primitives safely', () => {
    assert.deepEqual(safeErrMeta('string'), { type: 'string' });
    assert.deepEqual(safeErrMeta(42),       { type: 'number' });
  });

  it('handles null/undefined safely', () => {
    assert.ok(typeof safeErrMeta(null)      === 'object');
    assert.ok(typeof safeErrMeta(undefined) === 'object');
  });
});

// ---------------------------------------------------------------------------
// buildShutdown
// ---------------------------------------------------------------------------

describe('buildShutdown', () => {
  it('closes HTTP server and PostgreSQL pool (normal path)', async () => {
    const exits = [];
    const dbCalls = { n: 0 };
    const srv = makeServer();
    const { shutdown } = buildShutdown({
      getServer: () => srv,
      closeDb:   async () => { dbCalls.n++; },
      log:       makeLog(),
      timeoutMs: 5000,
      exitFn:    (c) => exits.push(c),
    });
    await shutdown('SIGTERM', 0);
    assert.equal(srv.counts.close, 1, 'server.close called exactly once');
    assert.equal(dbCalls.n, 1,        'closeDb called exactly once');
    assert.deepEqual(exits, [0],       'exit code 0');
  });

  it('SIGTERM exits with code 0', async () => {
    const exits = [];
    const { shutdown } = buildShutdown({
      getServer: () => makeServer(), closeDb: async () => {},
      log: makeLog(), timeoutMs: 5000, exitFn: (c) => exits.push(c),
    });
    await shutdown('SIGTERM', 0);
    assert.deepEqual(exits, [0]);
  });

  it('SIGINT exits with code 0', async () => {
    const exits = [];
    const { shutdown } = buildShutdown({
      getServer: () => makeServer(), closeDb: async () => {},
      log: makeLog(), timeoutMs: 5000, exitFn: (c) => exits.push(c),
    });
    await shutdown('SIGINT', 0);
    assert.deepEqual(exits, [0]);
  });

  it('unhandledRejection exits with requested code 1 after full cleanup', async () => {
    const exits = [];
    const dbCalls = { n: 0 };
    const { shutdown } = buildShutdown({
      getServer: () => makeServer(),
      closeDb:   async () => { dbCalls.n++; },
      log:       makeLog(),
      timeoutMs: 5000,
      exitFn:    (c) => exits.push(c),
    });
    await shutdown('unhandledRejection', 1);
    assert.equal(dbCalls.n, 1, 'closeDb still runs for unhandledRejection');
    assert.deepEqual(exits, [1]);
  });

  it('exitFn called exactly once', async () => {
    const exits = [];
    const { shutdown } = buildShutdown({
      getServer: () => makeServer(), closeDb: async () => {},
      log: makeLog(), timeoutMs: 5000, exitFn: (c) => exits.push(c),
    });
    await shutdown('SIGTERM', 0);
    assert.equal(exits.length, 1, 'exitFn must be called exactly once');
  });

  it('duplicate shutdown() calls return the same Promise and run cleanup once', async () => {
    const exits = [];
    const dbCalls = { n: 0 };
    const srv = makeServer();
    const { shutdown } = buildShutdown({
      getServer: () => srv,
      closeDb:   async () => { dbCalls.n++; },
      log:       makeLog(),
      timeoutMs: 5000,
      exitFn:    (c) => exits.push(c),
    });
    const p1 = shutdown('SIGTERM', 0);
    const p2 = shutdown('SIGTERM', 0);
    assert.strictEqual(p1, p2, 'same Promise reference returned for duplicate calls');
    await p1;
    assert.equal(srv.counts.close, 1, 'server.close called only once');
    assert.equal(dbCalls.n, 1,        'closeDb called only once');
    assert.deepEqual(exits, [0]);
  });

  it('duplicate server.close callbacks do not trigger double cleanup or double exit', async () => {
    const exits = [];
    const dbCalls = { n: 0 };
    const srv = makeServer({ fireCallbackTwice: true });
    const { shutdown } = buildShutdown({
      getServer: () => srv,
      closeDb:   async () => { dbCalls.n++; },
      log:       makeLog(),
      timeoutMs: 5000,
      exitFn:    (c) => exits.push(c),
    });
    shutdown('SIGTERM', 0);
    await wait(50);
    assert.equal(dbCalls.n, 1,   'closeDb called exactly once despite double callback');
    assert.equal(exits.length, 1, 'exitFn called exactly once');
  });

  it('tolerates server.close throwing synchronously — treated as HTTP close error → exit 1', async () => {
    const exits = [];
    const syncErr = Object.assign(new Error('synchronous close failure'), { name: 'SyncCloseError' });
    const { shutdown } = buildShutdown({
      getServer: () => makeServer({ syncThrow: syncErr }),
      closeDb:   async () => {},
      log:       makeLog(),
      timeoutMs: 5000,
      exitFn:    (c) => exits.push(c),
    });
    await shutdown('SIGTERM', 0);
    assert.deepEqual(exits, [1], 'sync throw → exit 1');
  });

  it('rejected closeDb produces exit code 1', async () => {
    const exits = [];
    const { shutdown } = buildShutdown({
      getServer: () => makeServer(),
      closeDb:   async () => { throw Object.assign(new Error('pool error'), { code: 'ETIMEDOUT' }); },
      log:       makeLog(),
      timeoutMs: 5000,
      exitFn:    (c) => exits.push(c),
    });
    await shutdown('SIGTERM', 0);
    assert.deepEqual(exits, [1], 'rejected closeDb → exit 1');
  });

  it('force timer is cleared after successful cleanup', async () => {
    const ft = makeFakeTimers();
    const exits = [];
    const { shutdown } = buildShutdown({
      getServer:  () => makeServer(),
      closeDb:    async () => {},
      log:        makeLog(),
      timeoutMs:  5000,
      exitFn:     (c) => exits.push(c),
      setTimer:   ft.set,
      clearTimer: ft.clear,
    });
    await shutdown('SIGTERM', 0);
    assert.ok(ft.wasCleared(1), 'force timer (id=1) must be cleared after cleanup completes');
    assert.deepEqual(exits, [0]);
  });

  it('hanging cleanup triggers timeout exit code 1', () => {
    const ft = makeFakeTimers();
    const exits = [];
    const { shutdown } = buildShutdown({
      getServer:  makeHangingServer,
      closeDb:    async () => {},
      log:        makeLog(),
      timeoutMs:  1000,
      exitFn:     (c) => exits.push(c),
      setTimer:   ft.set,
      clearTimer: ft.clear,
    });
    shutdown('SIGTERM', 0); // do not await — server callback never fires
    ft.fire(1);             // manually fire the force timer
    assert.deepEqual(exits, [1], 'timed-out shutdown must exit with code 1');
  });

  it('fake passwords, tokens, and DATABASE_URL never appear in any log entry', async () => {
    const FAKE_PWD  = 'superSecretP4ssword!';
    const FAKE_URL  = 'postgresql://admin:superSecretP4ssword!@prod.db.internal:5432/qyrvia';
    const FAKE_TOK  = 'eyJhbGciOiJIUzI1NiJ9.fakepayload.fakesig';
    const log = makeLog();

    const { shutdown } = buildShutdown({
      getServer: () => makeServer(),
      closeDb:   async () => {},
      log,
      timeoutMs: 5000,
      exitFn:    () => {},
    });

    // Simulate what index.js does for unhandledRejection
    const reason = Object.assign(new Error(FAKE_URL), { code: 'ECONNREFUSED' });
    const s = safeErrMeta(reason);
    log.fatal({ reason: s }, '[qyrvia] unhandledRejection — initiating graceful shutdown');
    await shutdown('unhandledRejection', 1);

    const dump = log.dump();
    assert.ok(!dump.includes(FAKE_PWD),       'password must not appear in logs');
    assert.ok(!dump.includes(FAKE_URL),        'DATABASE_URL must not appear in logs');
    assert.ok(!dump.includes(FAKE_TOK),        'JWT token must not appear in logs');
    assert.ok(!dump.includes('@prod.db'),      'hostname must not appear in logs');
    assert.ok(!dump.includes('superSecret'),   'partial password must not appear in logs');
  });
});
