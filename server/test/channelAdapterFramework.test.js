'use strict';

/** Phase 24 B8-A - unified OTA adapter framework: registry, contract, lifecycle, bridge. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fw = require('../src/channel-manager/adapters/framework');
const { CANONICAL_METHODS, validator, buildAdapterRegistry, bridgeLegacyAdapter, buildCanonicalAdapterRegistry, NoopAuthStrategy } = fw;

// A minimal compliant canonical adapter for focused tests.
function fakeAdapter(channel = 'test.ota') {
  return {
    channel,
    auth: new NoopAuthStrategy(),
    async init() {}, async health() { return { ok: true }; }, async close() {},
    normalizeBooking(raw) { return { bookingId: raw.id, channel, status: raw.status || 'PENDING' }; },
    async pushReservation() { return { ok: true }; },
    async pushAvailability() { return { ok: true }; },
    async pushRateUpdate() { return { ok: true }; },
    handleWebhook(req) { return { verified: true, events: (req.bookings || []).map((r) => ({ bookingId: r.id, channel, status: r.status })) }; }
  };
}

// ---- 1. adapter registration ----------------------------------------------
test('adapter registration: register + resolve + list; duplicate rejected', () => {
  const reg = buildAdapterRegistry();
  reg.register(fakeAdapter('a.ota'));
  assert.equal(reg.has('a.ota'), true);
  assert.equal(reg.get('a.ota').channel, 'a.ota');
  assert.throws(() => reg.register(fakeAdapter('a.ota')), /duplicate channel/);
  assert.deepEqual(reg.list(), ['a.ota']);
});

// ---- 2. interface enforcement ---------------------------------------------
test('interface enforcement: missing method fails validation + registration', () => {
  const broken = fakeAdapter('broken.ota');
  delete broken.pushRateUpdate;
  const v = validator.validateInterface(broken);
  assert.equal(v.ok, false);
  assert.ok(v.missing.includes('pushRateUpdate'));
  assert.throws(() => buildAdapterRegistry().register(broken), /missing pushRateUpdate/);
});

test('canonical contract advertises all 8 methods', () => {
  assert.deepEqual(CANONICAL_METHODS, ['init', 'health', 'close', 'normalizeBooking',
    'pushReservation', 'pushAvailability', 'pushRateUpdate', 'handleWebhook']);
});

// ---- 3. lifecycle enforcement ---------------------------------------------
test('lifecycle enforcement: init/health/close validated; bad health flagged', async () => {
  const ok = await validator.validateLifecycle(fakeAdapter());
  assert.equal(ok.ok, true);

  const bad = fakeAdapter('bad.ota');
  bad.health = async () => ({ nope: true }); // not { ok:boolean }
  const r = await validator.validateLifecycle(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /health/.test(e)));
});

// ---- 4. registry resolution -----------------------------------------------
test('registry resolution: canonical registry loads the 5 live mock adapters', () => {
  const reg = buildCanonicalAdapterRegistry();
  const channels = reg.list();
  assert.equal(channels.length, 5);
  for (const c of channels) {
    const a = reg.get(c);
    assert.equal(validator.validateInterface(a).ok, true, c + ' must satisfy the canonical interface');
  }
  assert.throws(() => reg.get('nonexistent'), /unknown channel/);
});

// ---- 5. normalization validation ------------------------------------------
test('normalization validation: bridged mock yields a canonical booking', () => {
  const reg = buildCanonicalAdapterRegistry();
  const adapter = reg.all()[0];
  const v = validator.validateNormalization(adapter, { id: 'X1', status: 'CONFIRMED', guestName: 'A', checkin: '2026-07-01', checkout: '2026-07-03' });
  assert.equal(v.ok, true, v.errors.join(','));

  const missing = { normalizeBooking: () => ({ channel: 'c' }) }; // no bookingId/status
  const bad = validator.validateNormalization(missing, {});
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /bookingId/.test(e)));
});

test('full validateAll passes for every bridged live adapter', async () => {
  const reg = buildCanonicalAdapterRegistry();
  const results = await reg.validateAll({ sampleRaw: { id: 'R1', status: 'CONFIRMED' } });
  for (const [channel, res] of Object.entries(results)) {
    assert.equal(res.ok, true, channel + ': ' + JSON.stringify(res));
  }
});

// ---- 6. deprecated adapter compatibility ----------------------------------
test('deprecated framework: still functional + marked DEPRECATED', () => {
  const legacyReg = require('../src/channel-manager/registry/adapterRegistry');
  const assertMod = require('../src/channel-manager/adapters/base/assertAdapter');
  // marked deprecated
  assert.equal(legacyReg.DEPRECATED, true);
  assert.equal(assertMod.DEPRECATED, true);
  // still functional (compatibility preserved; ota_scale.test.js relies on it)
  assert.ok(Array.isArray(legacyReg.list()));
  assert.ok(legacyReg.list().length > 0);
  const name = legacyReg.list()[0];
  assert.equal(legacyReg.has(name), true);
});

// ---- bridge behavior -------------------------------------------------------
test('legacy bridge: delegates push/normalize/webhook to the mock; no secrets', async () => {
  const { BookingComAdapter } = require('../src/channel-manager/adapters/bookingcom/BookingComAdapter');
  const bridged = bridgeLegacyAdapter(new BookingComAdapter());
  assert.ok(bridged.auth instanceof NoopAuthStrategy);
  assert.equal(bridged.auth.credentialsRef, null); // no secret
  assert.equal((await bridged.health()).ok, true);
  assert.equal((await bridged.pushRateUpdate({ amount: 100, currency: 'USD' })).ok, true);
  assert.equal((await bridged.pushAvailability({ available: 3 })).ok, true);
  const norm = bridged.normalizeBooking({ id: 'B9', status: 'CONFIRMED' });
  assert.equal(norm.bookingId, 'B9');
  const wh = bridged.handleWebhook({ bookings: [{ id: 'B1', status: 'CONFIRMED' }] });
  assert.equal(wh.verified, true);
  assert.equal(wh.events[0].bookingId, 'B1');
});
