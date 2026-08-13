'use strict';

/**
 * Phase 66A-B2N-D — static ARCHITECTURAL guards for the ARI outbox worker.
 *
 * These read source as TEXT. They are guards, not proof of behaviour: the
 * behavioural suite (phase66a_b2nd_ari_outbox_worker.test.js) proves what the
 * worker DOES. What these catch is the class of edit that behaviour tests
 * cannot see — an import that couples server/src/ari/ to the channel manager, a
 * bare-pool query that escapes the tenant-bound wrappers, an HTTP client
 * appearing inside a module that is supposed to be transport-free, or a gate
 * quietly defaulting to on.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const WORKER_PATH = path.join(SRC, 'ari', 'outbox', 'ariOutboxWorker.js');
const RESOLVER_PATH = path.join(SRC, 'ari', 'outbox', 'ariOutboxTenantResolver.js');
const ENV_PATH = path.join(SRC, 'config', 'env.js');
const INDEX_PATH = path.join(SRC, 'index.js');

const WORKER = fs.readFileSync(WORKER_PATH, 'utf8');
const RESOLVER = fs.readFileSync(RESOLVER_PATH, 'utf8');
const ENV = fs.readFileSync(ENV_PATH, 'utf8');
const INDEX = fs.readFileSync(INDEX_PATH, 'utf8');

/** Strip block and line comments, so prose can never satisfy an assertion. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const WORKER_CODE = codeOnly(WORKER);
const RESOLVER_CODE = codeOnly(RESOLVER);
const INDEX_CODE = codeOnly(INDEX);

/** Every require() target in a file. */
function requires(code) {
  return (code.match(/require\(\s*['"]([^'"]+)['"]\s*\)/g) || [])
    .map((m) => m.replace(/^require\(\s*['"]/, '').replace(/['"]\s*\)$/, ''));
}

// ---------------------------------------------------------------------------
// 1. Decoupling — the invariant that keeps server/src/ari/ transport-free
// ---------------------------------------------------------------------------

test('1. the worker imports no channel-manager module', () => {
  for (const r of requires(WORKER_CODE)) {
    assert.ok(!/channel-manager|channelManager/i.test(r),
      'server/src/ari/ must keep ZERO channel-manager coupling; found ' + r);
  }
});

test('2. the worker imports no adapter, provider registry or credential provider', () => {
  for (const r of requires(WORKER_CODE)) {
    assert.ok(!/adapter|provider|registry|credential|secret/i.test(r),
      'transport-free by construction; found ' + r);
  }
});

test('3. the worker imports no HTTP client and performs no network call', () => {
  for (const r of requires(WORKER_CODE)) {
    assert.ok(!/^(axios|got|node-fetch|undici|superagent|request|https?)$/i.test(r),
      'no HTTP client may enter this module; found ' + r);
    assert.ok(!/^node:(http|https|net|tls|dgram)$/.test(r), 'no network core module; found ' + r);
  }
  assert.ok(!/\bfetch\s*\(/.test(WORKER_CODE), 'no fetch()');
  assert.ok(!/XMLHttpRequest|WebSocket/.test(WORKER_CODE));
});

test('4. the worker reads no environment and no .env', () => {
  assert.ok(!/process\.env/.test(WORKER_CODE),
    'gates arrive through injected config predicates, never read directly');
  assert.ok(!/dotenv|\.env\b/.test(WORKER_CODE));
  for (const r of requires(WORKER_CODE)) {
    assert.ok(!/config\/env/.test(r), 'the worker must not import env directly; found ' + r);
  }
});

test('5. the worker imports ONLY its own sibling resolver module', () => {
  const reqs = requires(WORKER_CODE);
  assert.deepEqual(reqs, ['./ariOutboxTenantResolver'],
    'the worker is pure logic over injected dependencies');
});

// ---------------------------------------------------------------------------
// 2. No direct database access
// ---------------------------------------------------------------------------

test('6. the worker issues no SQL and never queries the pool itself', () => {
  assert.ok(!/pool\.query\s*\(/.test(WORKER_CODE),
    'every outbox operation must go through the tenant-bound wrappers');
  assert.ok(!/db\.query\s*\(/.test(WORKER_CODE));
  assert.ok(!/\.query\s*\(\s*['"`]/.test(WORKER_CODE), 'no inline SQL string');
  for (const kw of ['SELECT ', 'INSERT ', 'UPDATE ', 'DELETE ', 'BEGIN', 'COMMIT']) {
    assert.ok(!new RegExp('["\'`][^"\'`]*\\b' + kw, 'i').test(WORKER_CODE),
      'no SQL keyword in a string literal: ' + kw);
  }
});

test('7. the worker never queries the tenants table or looks up a tenant code', () => {
  // `tenants` is a legitimate local variable holding the resolver's output, so
  // the bare word proves nothing. What must never appear is a SQL-shaped
  // reference to the table, or any tenant-code lookup — tenant discovery is
  // the resolver's job and the code column is behind the same FORCE RLS.
  assert.ok(!/(FROM|JOIN|INTO|UPDATE)\s+tenants\b/i.test(WORKER_CODE),
    'tenant discovery belongs to the resolver');
  assert.ok(!/tenant_code|tenantCode/.test(WORKER_CODE));
  assert.ok(!/\.code\b/.test(WORKER_CODE), 'no tenant-code access of any kind');
});

test('8. the worker never names ari_outbox_store directly', () => {
  assert.ok(!/ari_outbox_store/.test(WORKER_CODE),
    'the table is reached only through tenantAriOutbox wrappers');
});

test('9. the worker opens no transaction of its own', () => {
  assert.ok(!/runWithTenantTransaction|BEGIN|COMMIT|ROLLBACK/.test(WORKER_CODE),
    'the tenant-bound wrappers own every transaction');
  assert.ok(!/SET\s+ROLE|set_config|app\.tenant_id/i.test(WORKER_CODE),
    'no manual tenant binding and no role switching');
});

test('10. every outbox operation the worker performs is a tenant-bound wrapper call', () => {
  const expected = ['requeueExpiredLeasesForTenant', 'claimDueForTenant',
                    'markCompletedForTenant', 'markRetryScheduledForTenant',
                    'markDeadLetterForTenant'];
  for (const fn of expected) {
    assert.ok(new RegExp('outbox\\.' + fn + '\\s*\\(').test(WORKER_CODE),
      'expected a tenant-bound call to ' + fn);
  }
  // Every call must pass a tenantId — an un-scoped call would escape RLS.
  const calls = WORKER_CODE.match(/outbox\.\w+ForTenant\s*\(\s*\{[^}]*\}/g) || [];
  assert.ok(calls.length >= expected.length);
  for (const c of calls) {
    assert.ok(/tenantId/.test(c), 'every wrapper call must carry tenantId: ' + c.slice(0, 80));
  }
});

// ---------------------------------------------------------------------------
// 3. The resolver is the ONLY caller of the definer function
// ---------------------------------------------------------------------------

test('11. only ariOutboxTenantResolver names due_ari_outbox_tenants', () => {
  assert.match(RESOLVER_CODE, /due_ari_outbox_tenants/);
  assert.ok(!/due_ari_outbox_tenants/.test(WORKER_CODE),
    'the worker reaches the resolver through injection, never by name');

  // Sweep the whole source tree: exactly one module may reference it.
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.js$/.test(e.name)) continue;
      if (/due_ari_outbox_tenants/.test(codeOnly(fs.readFileSync(p, 'utf8')))) hits.push(p);
    }
  })(SRC);
  assert.deepEqual(hits, [RESOLVER_PATH],
    'exactly one module may call the BYPASSRLS resolver; found ' + hits.join(', '));
});

test('12. the resolver queries nothing but that one function', () => {
  const queries = RESOLVER_CODE.match(/pool\.query\s*\([\s\S]*?\)/g) || [];
  assert.equal(queries.length, 1, 'exactly one query site');
  assert.ok(!/FROM\s+tenants|JOIN\s+tenants/i.test(RESOLVER_CODE));
  assert.ok(!/ari_outbox_store/.test(RESOLVER_CODE), 'the outbox table is not the resolver business');
  assert.ok(!/SET\s+ROLE|set_config|app\.tenant_id/i.test(RESOLVER_CODE));
  assert.ok(!/BYPASSRLS/i.test(RESOLVER_CODE));
});

test('13. the resolver binds its limit as a parameter and validates the range', () => {
  assert.match(RESOLVER_CODE, /\(\$1\)/, 'the limit must be a bound parameter');
  assert.ok(!/\$\{/.test(RESOLVER_CODE.split('\n').filter((l) => /query/.test(l)).join('\n')),
    'no template interpolation into SQL');
  assert.match(RESOLVER_CODE, /MIN_LIMIT\s*=\s*1/);
  assert.match(RESOLVER_CODE, /MAX_LIMIT\s*=\s*1000/);
});

test('14. the resolver validates UUIDs and fails closed', () => {
  assert.match(RESOLVER_CODE, /UUID_RE/);
  assert.match(RESOLVER_CODE, /throw fail\('resolver returned a non-UUID tenant identifier'\)/);
});

test('15. neither module logs a credential or an environment value', () => {
  for (const code of [WORKER_CODE, RESOLVER_CODE]) {
    assert.ok(!/process\.env/.test(code));
    assert.ok(!/password|secret|apiKey|api_key|token|credential/i.test(code));
  }
});

// ---------------------------------------------------------------------------
// 4. The gates
// ---------------------------------------------------------------------------

test('16. both ARI gates exist in env.js and default to false', () => {
  assert.match(ENV, /ARI_OUTBOX_WORKER_ENABLED:\s*getOptional\('ARI_OUTBOX_WORKER_ENABLED',\s*'false'\)/);
  assert.match(ENV, /ARI_OUTBOX_DISPATCH_ENABLED:\s*getOptional\('ARI_OUTBOX_DISPATCH_ENABLED',\s*'false'\)/);
});

test('17. the channel worker gates are unchanged by this phase', () => {
  assert.match(ENV, /CHANNEL_WORKER_ENABLED:\s*getOptional\('CHANNEL_WORKER_ENABLED',\s*'false'\)/);
  assert.match(ENV, /CHANNEL_QUEUE_DISPATCH_ENABLED:\s*getOptional\('CHANNEL_QUEUE_DISPATCH_ENABLED',\s*'false'\)/);
  assert.match(ENV, /CHANNEL_WORKER_REAL:\s*getOptional\('CHANNEL_WORKER_REAL',\s*'false'\)/);
});

test('18. boot compares each ARI gate to the literal string true', () => {
  assert.match(INDEX_CODE, /ARI_OUTBOX_WORKER_ENABLED === 'true'/);
  assert.match(INDEX_CODE, /ARI_OUTBOX_DISPATCH_ENABLED === 'true'/);
});

test('19. the worker checks both gates AND readiness before resolving tenants', () => {
  // Order matters: resolution calls a BYPASSRLS definer function.
  const readyFn = WORKER_CODE.slice(WORKER_CODE.indexOf('function readyToWork'));
  const body = readyFn.slice(0, readyFn.indexOf('\n  }'));
  assert.match(body, /isEnabled\(\)\s*!==\s*true/);
  assert.match(body, /isDispatchEnabled\(\)\s*!==\s*true/);
  assert.match(body, /dispatcher\.isReady/);

  const tick = WORKER_CODE.slice(WORKER_CODE.indexOf('async tick()'));
  const guardAt = tick.indexOf('readyToWork()');
  const resolveAt = tick.indexOf('resolveDueTenants');
  assert.ok(guardAt > -1 && resolveAt > -1 && guardAt < resolveAt,
    'the gate check must precede tenant resolution');
});

test('20. gate predicates default to closed when config omits them', () => {
  assert.match(WORKER_CODE, /isEnabled\s*=\s*typeof cfg\.isEnabled === 'function'\s*\?\s*cfg\.isEnabled\s*:\s*\(\)\s*=>\s*false/);
  assert.match(WORKER_CODE, /isDispatchEnabled\s*=\s*typeof cfg\.isDispatchEnabled === 'function'\s*\?\s*cfg\.isDispatchEnabled\s*:\s*\(\)\s*=>\s*false/);
});

test('21. a dispatcher without isReady() is treated as not ready', () => {
  assert.match(WORKER_CODE, /typeof dispatcher\.isReady !== 'function'\)\s*return false/);
});

// ---------------------------------------------------------------------------
// 5. Boot wiring ships no success dispatcher and no polling loop
// ---------------------------------------------------------------------------

test('22. boot wires a NOT-READY dispatcher that cannot acknowledge success', () => {
  const block = INDEX_CODE.slice(INDEX_CODE.indexOf("ARI_OUTBOX_WORKER_ENABLED === 'true'"));
  const scoped = block.slice(0, block.indexOf('[boot] ARI outbox worker disabled'));
  assert.match(scoped, /isReady:\s*\(\)\s*=>\s*false/, 'the boot dispatcher must report not ready');
  assert.match(scoped, /ari_outbox_dispatch_not_implemented/);
  assert.ok(!/markCompleted|resolve\(\)/.test(scoped), 'no success acknowledgement at boot');
});

test('23. boot starts no polling loop in this phase', () => {
  const block = INDEX_CODE.slice(INDEX_CODE.indexOf("ARI_OUTBOX_WORKER_ENABLED === 'true'"));
  const scoped = block.slice(0, block.indexOf('[boot] ARI outbox worker disabled'));
  assert.ok(!/setInterval|setTimeout|\.start\(\)/.test(scoped),
    'tick() exists and is tested, but nothing schedules it until a transport lands');
});

test('24. boot passes the tenant-bound wrappers, not a raw store', () => {
  const block = INDEX_CODE.slice(INDEX_CODE.indexOf("ARI_OUTBOX_WORKER_ENABLED === 'true'"));
  const scoped = block.slice(0, block.indexOf('[boot] ARI outbox worker disabled'));
  assert.match(scoped, /require\('\.\/ari\/outbox\/tenantAriOutbox'\)/);
  assert.ok(!/buildAriOutboxStore/.test(scoped),
    'the raw store would bypass the tenant-bound transaction');
});

test('25. boot gives the worker a lease identity distinct per instance', () => {
  const block = INDEX_CODE.slice(INDEX_CODE.indexOf("ARI_OUTBOX_WORKER_ENABLED === 'true'"));
  const scoped = block.slice(0, block.indexOf('[boot] ARI outbox worker disabled'));
  assert.match(scoped, /workerId:/);
  assert.match(scoped, /process\.pid/, 'two workers sharing a lease_owner would be unattributable');
});

test('26. the ARI boot block reads no CHANNEL_* gate', () => {
  const block = INDEX_CODE.slice(INDEX_CODE.indexOf("ARI_OUTBOX_WORKER_ENABLED === 'true'"));
  const scoped = block.slice(0, block.indexOf('[boot] ARI outbox worker disabled'));
  assert.ok(!/CHANNEL_/.test(scoped), 'the two workers must not share a kill switch');
});

// ---------------------------------------------------------------------------
// 6. Migration and bootstrap responsibilities stay separated
// ---------------------------------------------------------------------------

test('27. migration 0089 creates no function — the bootstrap is the only creation path', () => {
  const mig = fs.readFileSync(
    path.join(SRC, 'db', 'migrations', '0089_ari_outbox_worker_resolver.sql'), 'utf8')
    .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  assert.ok(!/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(mig));
  assert.match(mig, /GRANT\s+SELECT\s*\(/i, 'the migration carries only the column grants');

  const boot = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'db', 'phase66a_ari_outbox_worker_resolver_bootstrap.sql'), 'utf8');
  assert.match(boot, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+worker_resolvers\.due_ari_outbox_tenants/i);
});

test('28. no repository code executes either bootstrap script', () => {
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.js$/.test(e.name)) continue;
      const c = codeOnly(fs.readFileSync(p, 'utf8'));
      if (/phase66a_ari_outbox_worker_resolver_bootstrap|phase66a_worker_resolvers_bootstrap/.test(c)) hits.push(p);
    }
  })(SRC);
  assert.deepEqual(hits, [], 'a bootstrap requires superuser and must only ever be run by an operator');
});
