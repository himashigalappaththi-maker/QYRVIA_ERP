#!/usr/bin/env node
'use strict';

/**
 * Phase 63 P1-2 — executable post-deploy smoke test.
 *
 * Replaces the manual checkbox list in deployment/SMOKE_TEST_CHECKLIST.md with
 * something a deploy pipeline can actually gate on.
 *
 * SAFETY CONTRACT
 * ───────────────
 *  1. READ-ONLY. Every probe is a GET. The script never POSTs, never mutates,
 *     never authenticates, and never sends a payload.
 *  2. LOCAL BY DEFAULT. The target is http://127.0.0.1:<PORT>. Any non-local
 *     host is REFUSED unless --allow-remote is passed explicitly on the command
 *     line, so it cannot be pointed at production by accident or by an
 *     environment variable alone.
 *  3. NO SECRETS. It reads no credentials and prints no headers.
 *
 * Usage:
 *   node scripts/smoke-test.js
 *   node scripts/smoke-test.js --base http://127.0.0.1:3001
 *   node scripts/smoke-test.js --base https://staging.example.com --allow-remote
 *
 * Exit codes: 0 = all required probes passed, 1 = at least one failed,
 *             2 = refused to run (unsafe target / bad arguments).
 */

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const TIMEOUT_MS = 8000;

function parseArgs(argv) {
  const out = { base: null, allowRemote: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') { out.base = argv[++i]; continue; }
    if (a === '--allow-remote') { out.allowRemote = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    return { error: 'unknown argument: ' + a };
  }
  return out;
}

/**
 * Probe definitions. `required:false` probes report but do not fail the run —
 * they cover surfaces that are legitimately disabled by configuration.
 */
const PROBES = [
  { name: 'liveness',            path: '/health/live',       expect: [200], required: true,
    check: (b) => b && b.status === 'ok' ? null : 'body.status !== "ok"' },
  { name: 'readiness (db)',      path: '/health/ready',      expect: [200], required: true,
    check: (b) => b && b.db === 'ok' ? null : 'body.db !== "ok"' },
  { name: 'api liveness',        path: '/api/health/live',   expect: [200], required: true },
  { name: 'api readiness',       path: '/api/health/ready',  expect: [200], required: true },
  // An unauthenticated tenant-scoped call MUST be rejected. A 200 here means
  // the auth gate is missing — that is a hard failure, not a warning.
  { name: 'auth gate closed',    path: '/api/core',          expect: [401, 403], required: true },
  { name: 'unknown route 404',   path: '/api/__does_not_exist__', expect: [404], required: true },
  { name: 'metrics exposed',     path: '/api/platform/metrics', expect: [200, 401, 403, 404], required: false }
];

async function probe(base, p) {
  const url = base.replace(/\/+$/, '') + p.path;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', signal: ac.signal, redirect: 'manual' });
    const ms = Date.now() - started;
    let body = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) { try { body = await res.json(); } catch (_) { body = null; } }
    else { try { await res.text(); } catch (_) { /* ignore */ } }

    if (!p.expect.includes(res.status)) {
      return { name: p.name, ok: false, required: p.required, ms, status: res.status,
               detail: 'expected status ' + p.expect.join('|') + ', got ' + res.status };
    }
    if (p.check) {
      const problem = p.check(body);
      if (problem) return { name: p.name, ok: false, required: p.required, ms, status: res.status, detail: problem };
    }
    return { name: p.name, ok: true, required: p.required, ms, status: res.status };
  } catch (err) {
    return { name: p.name, ok: false, required: p.required, ms: Date.now() - started, status: null,
             detail: err.name === 'AbortError' ? 'timeout after ' + TIMEOUT_MS + 'ms' : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error('[smoke] ' + args.error); process.exit(2); }
  if (args.help) {
    console.log('usage: node scripts/smoke-test.js [--base <url>] [--allow-remote] [--json]');
    process.exit(0);
  }

  const base = args.base || ('http://127.0.0.1:' + (process.env.PORT || 3001));

  let parsed;
  try { parsed = new URL(base); }
  catch (_) { console.error('[smoke] --base is not a valid URL'); process.exit(2); }

  const isLocal = LOCAL_HOSTS.has(parsed.hostname);
  if (!isLocal && !args.allowRemote) {
    console.error('[smoke] SAFETY ABORT: target host is not local.');
    console.error('[smoke] Pass --allow-remote explicitly to probe a non-local deployment.');
    process.exit(2);
  }

  console.log('[smoke] target: ' + parsed.protocol + '//' + parsed.host + (isLocal ? ' (local)' : ' (REMOTE - explicitly allowed)'));
  console.log('[smoke] mode: read-only GET probes\n');

  const results = [];
  for (const p of PROBES) results.push(await probe(base, p));

  for (const r of results) {
    const mark = r.ok ? 'PASS' : (r.required ? 'FAIL' : 'WARN');
    const status = r.status === null ? '---' : r.status;
    console.log(
      `[smoke] ${mark.padEnd(4)} ${String(status).padEnd(4)} ${String(r.ms).padStart(5)}ms  ${r.name}` +
      (r.ok ? '' : '  <- ' + r.detail)
    );
  }

  const failed = results.filter((r) => !r.ok && r.required);
  const warned = results.filter((r) => !r.ok && !r.required);

  console.log('');
  console.log(`[smoke] ${results.length - failed.length - warned.length} passed, ${warned.length} warned, ${failed.length} failed`);

  if (args.json) console.log(JSON.stringify({ base: parsed.protocol + '//' + parsed.host, results }, null, 2));

  process.exit(failed.length > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => { console.error('[smoke] unexpected error: ' + String(err && err.message || err)); process.exit(1); });
}

module.exports = { PROBES, parseArgs, LOCAL_HOSTS };
