'use strict';

/**
 * Phase 63 P1-2 — the smoke-test script itself must be safe and correct.
 * These tests assert the safety contract (local-only by default, read-only)
 * and the probe set, without starting a server or making a network call.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'smoke-test.js');
const { PROBES, parseArgs, LOCAL_HOSTS } = require('../scripts/smoke-test');

test('every probe is a read-only GET path (no mutation surface)', () => {
  assert.ok(PROBES.length >= 6);
  for (const p of PROBES) {
    assert.ok(p.path.startsWith('/'), p.name + ': path must be relative');
    assert.ok(Array.isArray(p.expect) && p.expect.length > 0, p.name + ': must declare expected statuses');
    assert.equal(typeof p.required, 'boolean', p.name + ': must declare required');
  }
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(src), 'script must never issue a mutating request');
  assert.ok(!/\bbody:\s*/.test(src), 'script must never send a request body');
});

test('the auth gate probe treats a 200 as a hard failure', () => {
  const gate = PROBES.find((p) => p.name === 'auth gate closed');
  assert.ok(gate, 'an unauthenticated-access probe must exist');
  assert.equal(gate.required, true);
  assert.ok(!gate.expect.includes(200), 'an unauthenticated tenant call returning 200 must fail the smoke test');
  assert.deepEqual(gate.expect, [401, 403]);
});

test('liveness and readiness are both required probes', () => {
  const required = PROBES.filter((p) => p.required).map((p) => p.path);
  assert.ok(required.includes('/health/live'));
  assert.ok(required.includes('/health/ready'));
  assert.ok(required.includes('/api/health/live'));
  assert.ok(required.includes('/api/health/ready'));
});

test('readiness probe rejects a body that does not report db:ok', () => {
  const ready = PROBES.find((p) => p.path === '/health/ready');
  assert.equal(ready.check({ db: 'ok' }), null);
  assert.ok(ready.check({ db: 'down' }));
  assert.ok(ready.check(null));
});

test('argument parsing supports base/allow-remote/json and rejects unknown flags', () => {
  assert.deepEqual(parseArgs([]), { base: null, allowRemote: false, json: false });
  assert.equal(parseArgs(['--base', 'http://x']).base, 'http://x');
  assert.equal(parseArgs(['--allow-remote']).allowRemote, true);
  assert.equal(parseArgs(['--json']).json, true);
  assert.ok(parseArgs(['--nuke-prod']).error);
});

test('the local allow-list is exactly loopback', () => {
  assert.deepEqual([...LOCAL_HOSTS].sort(), ['127.0.0.1', '::1', '[::1]', 'localhost'].sort());
  assert.ok(!LOCAL_HOSTS.has('0.0.0.0'));
  assert.ok(!LOCAL_HOSTS.has('qyrvia.example.com'));
});

test('a non-local target without --allow-remote is refused with exit code 2', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [SCRIPT, '--base', 'https://prod.example.com'], {
    encoding: 'utf8', shell: false, timeout: 20000
  });
  assert.equal(r.status, 2, 'must refuse, not probe');
  assert.match(String(r.stderr), /SAFETY ABORT/);
});

test('an invalid --base is refused with exit code 2', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [SCRIPT, '--base', 'not a url'], {
    encoding: 'utf8', shell: false, timeout: 20000
  });
  assert.equal(r.status, 2);
});
