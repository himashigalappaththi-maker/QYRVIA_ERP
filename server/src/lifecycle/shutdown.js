'use strict';

/**
 * Phase 61: Graceful shutdown factory (P61-H2).
 *
 * Returns { shutdown, isShuttingDown } with all side-effecting dependencies
 * injected for testability.
 *
 * Preserved cleanup sequence (matches existing index.js shutdown):
 *   1. server.close(cb)  — stop accepting new HTTP connections
 *   2. await closeDb()   — drain and close the PostgreSQL pool
 *   3. 10-second forced exit timeout — last-resort bounded exit
 *
 * Additional guarantees:
 *   - Returns the same Promise on duplicate shutdown() calls.
 *   - _cleanupRan prevents double cleanup if server.close fires callback twice.
 *   - _exited ensures exitFn is called at most once.
 *   - Force timer is cleared immediately when cleanup begins.
 *   - server.close synchronous throws are handled as HTTP close errors.
 *   - Never logs message, stack, URL, password, or token fields.
 */

const SAFE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'ERR_SERVER_NOT_RUNNING', 'ERR_SERVER_DESTROYED',
]);

function safeErrMeta(val) {
  if (!val || typeof val !== 'object') return { type: typeof val };
  const out = {};
  if (typeof val.name === 'string') out.name = val.name;
  if (typeof val.code === 'string' && SAFE_CODES.has(val.code)) out.code = val.code;
  return out;
}

function buildShutdown({
  getServer,
  closeDb,
  log,
  timeoutMs,
  exitFn,
  setTimer   = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const _exit    = typeof exitFn === 'function' ? exitFn : (c) => process.exit(c);
  const _timeout = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 10000;

  let _shutdownPromise = null;
  let _resolveShutdown = null;
  let _cleanupRan      = false;
  let _exited          = false;
  let _forceTimer      = null;

  function safeExit(c) {
    if (_exited) return;
    _exited = true;
    _exit(c);
    if (_resolveShutdown) _resolveShutdown();
  }

  function shutdown(signal, exitCode) {
    const code = (exitCode !== undefined && exitCode !== null) ? Number(exitCode) : 0;

    if (_shutdownPromise) {
      if (log && log.warn) log.warn({ signal }, '[qyrvia] shutdown already in progress');
      return _shutdownPromise;
    }

    _shutdownPromise = new Promise((resolve) => { _resolveShutdown = resolve; });

    if (log && log.info) log.info({ signal }, '[qyrvia] shutdown requested');

    _forceTimer = setTimer(() => {
      if (log && log.error) log.error({ signal }, '[qyrvia] forced exit after timeout');
      safeExit(1);
    }, _timeout);
    if (_forceTimer && typeof _forceTimer.unref === 'function') _forceTimer.unref();

    async function doCleanup(httpErr) {
      if (_cleanupRan) return;
      _cleanupRan = true;
      clearTimer(_forceTimer);
      let finalCode = code;
      if (httpErr) {
        if (log && log.error) log.error({ err: safeErrMeta(httpErr) }, '[qyrvia] http close error');
        finalCode = 1;
      }
      try {
        if (typeof closeDb === 'function') await closeDb();
      } catch (dbErr) {
        if (log && log.error) log.error({ err: safeErrMeta(dbErr) }, '[qyrvia] db close error');
        finalCode = 1;
      }
      if (log && log.info) log.info('[qyrvia] shutdown complete');
      safeExit(finalCode);
    }

    const onClose = (err) => doCleanup(err || null).catch((e) => {
      if (log && log.error) log.error({ err: safeErrMeta(e) }, '[qyrvia] cleanup error');
      safeExit(1);
    });

    const srv = typeof getServer === 'function' ? getServer() : null;
    if (srv && typeof srv.close === 'function') {
      try { srv.close(onClose); } catch (syncErr) { onClose(syncErr); }
    } else {
      onClose(null);
    }

    return _shutdownPromise;
  }

  return { shutdown, isShuttingDown: () => _shutdownPromise !== null };
}

module.exports = { buildShutdown, safeErrMeta };
