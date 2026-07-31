'use strict';

/**
 * Phase 66A-B2L — real channel processor wired behind fail-closed master
 * gates and per-channel registry authorization (P0-12 real-processor
 * prerequisite).
 *
 * This file combines source-text contract checks (env.js/index.js boot
 * wiring — no execution, no database) with executing unit tests against
 * buildRealProcessor() using fake secretProvider/channelRegistry/qtcnTransport/
 * http dependencies — no socket, no DNS, no external SDK, ever. Live tenant-
 * bound DB integration with the real worker/adapter is covered by
 * test/db/phase66a_real_processor_registry_gate.db.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildRealProcessor } = require('../src/channel-manager/worker/realProcessor');
const { CHANNELS } = require('../src/channel-manager/core/canonical/types');

const ENV_PATH = path.join(__dirname, '..', 'src', 'config', 'env.js');
const INDEX_PATH = path.join(__dirname, '..', 'src', 'index.js');
const REALPROC_PATH = path.join(__dirname, '..', 'src', 'channel-manager', 'worker', 'realProcessor.js');

const ENV_SOURCE = fs.readFileSync(ENV_PATH, 'utf8');
const INDEX_SOURCE = fs.readFileSync(INDEX_PATH, 'utf8');
const REALPROC_SOURCE = fs.readFileSync(REALPROC_PATH, 'utf8');

function stripComments(src) {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks.split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
}
const ENV_CODE = stripComments(ENV_SOURCE);
const INDEX_CODE = stripComments(INDEX_SOURCE);
const REALPROC_CODE = stripComments(REALPROC_SOURCE);

// ---------------------------------------------------------------------------
// Environment setting
// ---------------------------------------------------------------------------

test('CHANNEL_WORKER_REAL exists, defaults to \'false\', via the existing getOptional convention', () => {
  assert.match(ENV_CODE, /CHANNEL_WORKER_REAL:\s*getOptional\('CHANNEL_WORKER_REAL',\s*'false'\)/);
});

// ---------------------------------------------------------------------------
// Boot wiring — three-gate truth table
// ---------------------------------------------------------------------------

function channelWorkerBootBlock() {
  const start = INDEX_CODE.indexOf("CHANNEL_WORKER_ENABLED === 'true'");
  assert.ok(start >= 0, 'channel worker boot block not found in index.js');
  const end = INDEX_CODE.indexOf('channel queue worker disabled', start);
  assert.ok(end > start);
  return INDEX_CODE.slice(start, end);
}
const BOOT_BLOCK = channelWorkerBootBlock();

test('the boot path reads all three independent gates: CHANNEL_WORKER_ENABLED, CHANNEL_QUEUE_DISPATCH_ENABLED, CHANNEL_WORKER_REAL', () => {
  assert.match(INDEX_CODE, /CHANNEL_WORKER_ENABLED === 'true'/);
  assert.match(BOOT_BLOCK, /CHANNEL_QUEUE_DISPATCH_ENABLED === 'true'/);
  assert.match(BOOT_BLOCK, /CHANNEL_WORKER_REAL === 'true'/);
});

test('buildRealProcessor is constructed only after the CHANNEL_WORKER_REAL check, and receives this boot\'s existing secretProvider and channelRegistry', () => {
  const gateIdx = BOOT_BLOCK.search(/CHANNEL_WORKER_REAL === 'true'/);
  const ctorIdx = BOOT_BLOCK.search(/buildRealProcessor\(\{/);
  assert.ok(gateIdx >= 0 && ctorIdx > gateIdx);
  const ctorBlock = BOOT_BLOCK.slice(ctorIdx, ctorIdx + 300);
  assert.match(ctorBlock, /secretProvider:\s*channelCredentials\s*&&\s*channelCredentials\.provider/);
  assert.match(ctorBlock, /channelRegistry/);
});

test('buildMockProcessor() remains the unconditional default; queueProcessor is only reassigned inside the real-mode branch', () => {
  assert.match(BOOT_BLOCK, /let queueProcessor = buildMockProcessor\(\);/);
  const defaultIdx = BOOT_BLOCK.search(/let queueProcessor = buildMockProcessor\(\);/);
  const reassignIdx = BOOT_BLOCK.search(/queueProcessor = buildRealProcessor/);
  assert.ok(defaultIdx >= 0 && reassignIdx > defaultIdx, 'default assignment must precede the real-mode reassignment');
  const between = BOOT_BLOCK.slice(defaultIdx, reassignIdx);
  assert.match(between, /if \(useReal\)/, 'the reassignment must be guarded by an explicit if (useReal) check');
});

test('the worker is always constructed with isDispatchEnabled — real mode cannot bypass the B2K master dispatch guard', () => {
  assert.match(BOOT_BLOCK, /buildChannelQueueWorker\(\{[\s\S]*?isDispatchEnabled,[\s\S]*?\}\)/);
  // Only one buildChannelQueueWorker call site exists — real vs mock only
  // changes which processor value is passed in, never whether the guard is.
  const workerCtors = BOOT_BLOCK.match(/buildChannelQueueWorker\(\{/g) || [];
  assert.equal(workerCtors.length, 1);
});

test('the boot path introduces no fetch/axios/http(s).request call of its own', () => {
  assert.ok(!/fetch\(|axios|http\.request|https\.request/i.test(BOOT_BLOCK));
});

test('no live provider credential, API key, OAuth token or endpoint is introduced in the boot path', () => {
  assert.ok(!/api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i.test(BOOT_BLOCK));
  assert.ok(!/booking\.com\/api|expedia\.com\/api|agoda\.com\/api/i.test(BOOT_BLOCK));
});

// ---------------------------------------------------------------------------
// realProcessor.js — construction contract
// ---------------------------------------------------------------------------

function makeSecretProvider(secret = null) { return { async get() { return secret; } }; }
function makeRegistry(enabledMap) {
  const calls = [];
  return {
    calls,
    async get(channel, ctx) {
      calls.push({ channel, ctx });
      if (typeof enabledMap === 'function') return enabledMap(channel, ctx);
      const v = enabledMap[channel];
      if (v === undefined) return null;
      return { enabled: v };
    }
  };
}
function makeSpyTransport(result = { ok: true, status: 200, ackId: 'ack-1' }) {
  const calls = [];
  return { calls, async send(req) { calls.push(req); return result; } };
}

const QC_JOB = {
  action: 'CREATE_BOOKING', channel: 'QYRVIA_CONNECT', tenant_id: 'T1', property_id: 'P1',
  credentials_ref: null, payload: { bookingId: 'BK-1', status: 'CONFIRMED' }
};
const OTA_JOB = {
  action: 'CREATE_BOOKING', channel: 'BOOKING_COM', tenant_id: 'T1', property_id: 'P1',
  credentials_ref: 'ref-1', payload: { bookingId: 'BK-2', status: 'CONFIRMED' }
};

test('buildRealProcessor throws without channelRegistry (same required-or-throw pattern as secretProvider)', () => {
  assert.throws(() => buildRealProcessor({ secretProvider: makeSecretProvider() }), /channelRegistry required/);
});

test('buildRealProcessor still throws without secretProvider, checked before channelRegistry', () => {
  assert.throws(() => buildRealProcessor({ channelRegistry: makeRegistry({}) }), /secretProvider required/);
});

test('source: channelRegistry check exists for both the QYRVIA Connect branch and the external-OTA branch', () => {
  const authCalls = REALPROC_CODE.match(/isChannelAuthorized\(/g) || [];
  assert.equal(authCalls.length, 3, 'expected the function definition plus exactly two call sites');
});

test('source: the external-OTA registry check happens after provider resolution (zero registry reads for an unknown channel)', () => {
  const providerIdx = REALPROC_CODE.search(/no_provider_for_channel/);
  const authIdx = REALPROC_CODE.indexOf('await isChannelAuthorized(channel, tenant_id, property_id)');
  assert.ok(providerIdx >= 0 && authIdx > providerIdx);
});

// ---------------------------------------------------------------------------
// realProcessor.js — QYRVIA Connect (in-process) registry gating
// ---------------------------------------------------------------------------

test('QYRVIA_CONNECT: authorized job dispatches via qtcnTransport and returns ok=true', async () => {
  const registry = makeRegistry({ QYRVIA_CONNECT: true });
  const qtcnTransport = makeSpyTransport({ ok: true, status: 200, ackId: 'ack-qc' });
  const p = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport });
  const out = await p.process(QC_JOB);
  assert.equal(out.ok, true);
  assert.equal(qtcnTransport.calls.length, 1);
});

test('QYRVIA_CONNECT: disabled registry record denies dispatch with zero transport calls', async () => {
  const registry = makeRegistry({ QYRVIA_CONNECT: false });
  const qtcnTransport = makeSpyTransport();
  const p = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport });
  const out = await p.process(QC_JOB);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'channel_disabled');
  assert.equal(out.skipped, true);
  assert.equal(qtcnTransport.calls.length, 0);
});

test('QYRVIA_CONNECT: absent registry record denies dispatch with zero transport calls', async () => {
  const registry = makeRegistry({});
  const qtcnTransport = makeSpyTransport();
  const p = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport });
  const out = await p.process(QC_JOB);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'channel_disabled');
  assert.equal(qtcnTransport.calls.length, 0);
});

test('QYRVIA_CONNECT: malformed enabled value (truthy non-boolean) denies dispatch', async () => {
  for (const malformed of ['true', 1, {}, [], 'yes']) {
    const registry = makeRegistry({ QYRVIA_CONNECT: malformed });
    const qtcnTransport = makeSpyTransport();
    const p = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport });
    const out = await p.process(QC_JOB);
    assert.equal(out.ok, false, `expected denial for enabled=${JSON.stringify(malformed)}`);
    assert.equal(out.skipped, true);
    assert.equal(qtcnTransport.calls.length, 0);
  }
});

test('QYRVIA_CONNECT: a registry lookup that throws denies dispatch, error never leaked', async () => {
  const registry = { async get() { throw new Error('secret_db_connection_string_xyz'); } };
  const qtcnTransport = makeSpyTransport();
  const p = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport });
  const out = await p.process(QC_JOB);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'channel_disabled');
  assert.ok(!JSON.stringify(out).includes('secret_db_connection_string_xyz'));
  assert.equal(qtcnTransport.calls.length, 0);
});

test('QYRVIA_CONNECT: a registry lookup that rejects (async throw) denies dispatch', async () => {
  const registry = { async get() { return Promise.reject(new Error('boom')); } };
  const qtcnTransport = makeSpyTransport();
  const p = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport });
  const out = await p.process(QC_JOB);
  assert.equal(out.ok, false);
  assert.equal(out.skipped, true);
  assert.equal(qtcnTransport.calls.length, 0);
});

test('legacy QTCN code is authorized under the canonical QYRVIA_CONNECT registry key', async () => {
  const registry = makeRegistry({ QYRVIA_CONNECT: true });
  const qtcnTransport = makeSpyTransport({ ok: true, status: 200, ackId: 'ack-legacy' });
  const p = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport });
  const out = await p.process({ ...QC_JOB, channel: 'QTCN' });
  assert.equal(out.ok, true);
  assert.equal(registry.calls[0].channel, CHANNELS.QYRVIA_CONNECT);
});

// ---------------------------------------------------------------------------
// realProcessor.js — external OTA registry gating
// ---------------------------------------------------------------------------

test('external OTA: authorized job with mock HTTP dispatches and returns ok=true', async () => {
  const registry = makeRegistry({ BOOKING_COM: true });
  const mockHttp = { kind: 'mock', enabled: true, async send() { return { ok: true, status: 200, body: { confirmation_id: 'ACK-1' } }; } };
  const p = buildRealProcessor({ secretProvider: makeSecretProvider({ api_key: 'k' }), channelRegistry: registry, http: mockHttp });
  const out = await p.process(OTA_JOB);
  assert.equal(out.ok, true);
});

test('external OTA: disabled registry denies dispatch before any transport call, even with a live-capable mock HTTP injected', async () => {
  const registry = makeRegistry({ BOOKING_COM: false });
  let httpCalls = 0;
  const mockHttp = { kind: 'mock', enabled: true, async send() { httpCalls += 1; return { ok: true, status: 200, body: {} }; } };
  const p = buildRealProcessor({ secretProvider: makeSecretProvider({ api_key: 'k' }), channelRegistry: registry, http: mockHttp });
  const out = await p.process(OTA_JOB);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'channel_disabled');
  assert.equal(out.skipped, true);
  assert.equal(httpCalls, 0, 'no HTTP call may occur for a registry-denied channel');
});

test('external OTA: unknown channel (no provider) makes zero registry calls and zero transport calls', async () => {
  const registry = makeRegistry({});
  const p = buildRealProcessor({ secretProvider: makeSecretProvider({ api_key: 'k' }), channelRegistry: registry });
  const out = await p.process({ ...OTA_JOB, channel: 'UNKNOWN_OTA_XYZ' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'no_provider_for_channel');
  assert.equal(registry.calls.length, 0, 'an unresolvable channel must never trigger a registry read');
});

test('external OTA: default disabled HTTP transport still returns transport_disabled for an authorized channel (no live wiring in this phase)', async () => {
  const registry = makeRegistry({ BOOKING_COM: true });
  const p = buildRealProcessor({ secretProvider: makeSecretProvider({ api_key: 'k' }), channelRegistry: registry });
  const out = await p.process(OTA_JOB);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'transport_disabled');
});

test('external OTA: a genuine transport failure (authorized, HTTP returns non-ok) is distinguishable from a registry denial (no skipped flag)', async () => {
  const registry = makeRegistry({ BOOKING_COM: true });
  const mockHttp = { kind: 'mock', enabled: true, async send() { return { ok: false, status: 500, body: { errors: [{ code: 'upstream_error' }] } }; } };
  const p = buildRealProcessor({ secretProvider: makeSecretProvider({ api_key: 'k' }), channelRegistry: registry, http: mockHttp });
  const out = await p.process(OTA_JOB);
  assert.equal(out.ok, false);
  assert.equal(out.skipped, undefined, 'a genuine transport failure must not carry the skipped flag');
});

// ---------------------------------------------------------------------------
// Tenant scoping, re-evaluation, cross-channel isolation, one-row-one-call
// ---------------------------------------------------------------------------

test('registry.get() is called with the job\'s own tenantId and propertyId (tenant-scoped, never inferred)', async () => {
  const registry = makeRegistry({ QYRVIA_CONNECT: true });
  const p = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport: makeSpyTransport() });
  await p.process({ ...QC_JOB, tenant_id: 'tenant-xyz', property_id: 'prop-abc' });
  assert.equal(registry.calls[0].ctx.tenantId, 'tenant-xyz');
  assert.equal(registry.calls[0].ctx.propertyId, 'prop-abc');
});

test('registry authorization is re-evaluated fresh for every job — disabling between two calls on the same processor instance blocks the second', async () => {
  let enabled = true;
  const registry = { calls: [], async get(channel) { this.calls.push(channel); return { enabled }; } };
  const qtcnTransport = makeSpyTransport();
  const p = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport });

  const out1 = await p.process(QC_JOB);
  assert.equal(out1.ok, true);
  enabled = false;
  const out2 = await p.process(QC_JOB);
  assert.equal(out2.ok, false);
  assert.equal(out2.skipped, true);
  assert.equal(qtcnTransport.calls.length, 1, 'only the first, authorized job actually dispatched');
});

test('cross-channel isolation: authorizing QYRVIA_CONNECT never authorizes a different channel code', async () => {
  const registry = makeRegistry({ QYRVIA_CONNECT: true, BOOKING_COM: false });
  const mockHttp = { kind: 'mock', enabled: true, async send() { return { ok: true, status: 200, body: {} }; } };
  const p = buildRealProcessor({ secretProvider: makeSecretProvider({ api_key: 'k' }), channelRegistry: registry, http: mockHttp, qtcnTransport: makeSpyTransport() });

  const qcOut = await p.process(QC_JOB);
  assert.equal(qcOut.ok, true);
  const otaOut = await p.process(OTA_JOB);
  assert.equal(otaOut.ok, false);
  assert.equal(otaOut.skipped, true);
});

test('one claimed row produces at most one adapter/transport call, whether authorized or denied', async () => {
  const registryAllow = makeRegistry({ QYRVIA_CONNECT: true });
  const qtcnA = makeSpyTransport();
  await buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registryAllow, qtcnTransport: qtcnA }).process(QC_JOB);
  assert.equal(qtcnA.calls.length, 1);

  const registryDeny = makeRegistry({ QYRVIA_CONNECT: false });
  const qtcnB = makeSpyTransport();
  await buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registryDeny, qtcnTransport: qtcnB }).process(QC_JOB);
  assert.equal(qtcnB.calls.length, 0);
});

// ---------------------------------------------------------------------------
// CHECK_IN / CHECK_OUT bypass the registry entirely (no external call exists)
// ---------------------------------------------------------------------------

test('CHECK_IN and CHECK_OUT never call the registry — there is no external call to authorize', async () => {
  const registry = makeRegistry({});
  const p = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry });
  const inOut = await p.process({ ...QC_JOB, action: 'CHECK_IN' });
  const outOut = await p.process({ ...QC_JOB, action: 'CHECK_OUT' });
  assert.equal(inOut.ok, true);
  assert.equal(outOut.ok, true);
  assert.equal(registry.calls.length, 0);
});

// ---------------------------------------------------------------------------
// No live network / no credential exposure
// ---------------------------------------------------------------------------

test('realProcessor.js still defaults to buildDisabledHttp() and buildInProcessTransport() — Phase 66A-B2L never enables live transport by itself', () => {
  assert.match(REALPROC_CODE, /const _http = http \|\| buildDisabledHttp\(\);/);
  assert.match(REALPROC_CODE, /const _qtcn = qtcnTransport \|\| buildInProcessTransport\(\);/);
  assert.ok(!/\bfetch\(|axios|http\.request\(|https\.request\(/i.test(REALPROC_CODE));
});
