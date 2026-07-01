'use strict';

/**
 * Instrumented pg pool (Phase 32). A transparent Proxy over a pg Pool (and, via
 * connect(), over checked-out clients) that times every query, records a
 * low-cardinality DB metric (op counter + latency histogram, plus a slow-query
 * bucket when applicable) and routes slow queries through the slow-query
 * detector. It is a drop-in replacement: every other pool/client member is
 * forwarded untouched.
 *
 * SAFETY: instrumentation never logs SQL text or parameters (only a SQL HASH
 * via the detector), the op label is whitelisted so series stay bounded, and
 * all recording is wrapped in try/catch so observability can never break or
 * slow down a query's result/throw path.
 */

// Whitelisted SQL verbs keep the {op} metric label low-cardinality.
const OPS = new Set([
  'select', 'insert', 'update', 'delete', 'with',
  'begin', 'commit', 'rollback', 'set', 'create',
  'alter', 'drop', 'truncate'
]);

/** First SQL keyword, lowercased and clamped to the whitelist (else 'other'). */
function opOf(sql) {
  const m = String(sql || '').replace(/^[\s(]+/, '').match(/^([a-zA-Z]+)/);
  const op = m ? m[1].toLowerCase() : 'other';
  return OPS.has(op) ? op : 'other';
}

/** Extract the SQL text from query args (string form or { text } config form). */
function sqlOf(args) {
  const a = args[0];
  if (typeof a === 'string') return a;
  if (a && typeof a.text === 'string') return a.text;
  return '';
}

function record(obs, sql, caller, ms) {
  try {
    // Detector LOGS the slow query (hash only) and returns the bucket (or null).
    const rec = obs.slowQuery.record({ sql, ms, caller });
    obs.metrics.dbQuery(opOf(sql), ms, { slowBucket: rec ? rec.bucket : null });
  } catch (_) { /* observability must never break a query */ }
}

function timedQuery(target, obs, caller, args) {
  const sql = sqlOf(args);
  const t0 = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - t0) / 1e6;

  let result;
  try {
    result = target.query.apply(target, args);
  } catch (err) {
    // Synchronous throw (e.g. bad call) - still account for it.
    record(obs, sql, caller, elapsed());
    throw err;
  }

  if (result && typeof result.then === 'function') {
    return result.then(
      (v) => { record(obs, sql, caller, elapsed()); return v; },
      (e) => { record(obs, sql, caller, elapsed()); throw e; }
    );
  }
  // Callback / non-promise form: record best-effort and pass through.
  record(obs, sql, caller, elapsed());
  return result;
}

function forward(target, prop, receiver) {
  const val = Reflect.get(target, prop, receiver);
  return typeof val === 'function' ? val.bind(target) : val;
}

/** Wrap a checked-out client so its queries are instrumented too. */
function instrumentClient(client, obs) {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'query') return (...args) => timedQuery(target, obs, 'tx', args);
      return forward(target, prop, receiver);
    }
  });
}

/**
 * Wrap a pg Pool. `caller` is an optional static label for direct pool queries.
 * @param {import('pg').Pool} pool
 * @param {ReturnType<import('./index').getObservability>} obs
 */
function instrumentPool(pool, obs, { caller = 'pool' } = {}) {
  if (!pool || !obs) return pool;
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'query') return (...args) => timedQuery(target, obs, caller, args);
      if (prop === 'connect') {
        return function (...args) {
          // Callback form: pass straight through (uncommon in this codebase).
          if (typeof args[args.length - 1] === 'function') return target.connect.apply(target, args);
          return target.connect.apply(target, args).then((client) => instrumentClient(client, obs));
        };
      }
      return forward(target, prop, receiver);
    }
  });
}

module.exports = { instrumentPool, instrumentClient, opOf };
