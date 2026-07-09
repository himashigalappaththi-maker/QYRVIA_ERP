'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildController } = require('../src/channel-manager/api/channel.controller');

// buildChannelConnectionTester requires channelManager; pass a minimal stub.
const stubCM = { getAdapter() { throw new Error('not_registered'); } };
const c = buildController({ channelManager: stubCM });

function makeReq(body, tenantId = 'tenant-1') {
  return { body, ctx: { tenantId, requestId: 'req-1' }, params: {} };
}
function makeRes() {
  const r = { _status: 200, _body: null };
  r.status = (s) => { r._status = s; return r; };
  r.json   = (b) => { r._body = b; return r; };
  return r;
}

test('reconciliation: missing channel returns 400 channel_required', async () => {
  const req = makeReq({});
  const res = makeRes();
  await c.reconciliation(req, res, (e) => { throw e; });
  assert.equal(res._status, 400);
  assert.equal(res._body.ok, false);
});

test('reconciliation: missing tenant returns 401 tenant_required', async () => {
  const req = makeReq({ channel: 'BOOKING_COM' }, null);
  req.ctx.tenantId = undefined;
  const res = makeRes();
  await c.reconciliation(req, res, (e) => { throw e; });
  assert.equal(res._status, 401);
  assert.equal(res._body.ok, false);
});

test('reconciliation: empty local + remote → no drift, hasDrift=false', async () => {
  const req = makeReq({ channel: 'BOOKING_COM', local: {}, remote: {} });
  const res = makeRes();
  await c.reconciliation(req, res, (e) => { throw e; });
  assert.equal(res._body.ok, true);
  assert.equal(res._body.data.hasDrift, false);
  assert.equal(res._body.data.channel, 'BOOKING_COM');
});

test('reconciliation: local inventory not in remote → missing_remote drift', async () => {
  const req = makeReq({
    channel: 'AGODA',
    local:  { inventory: [{ key: 'STD|2026-08-01', available: 5, stopSell: false }] },
    remote: { inventory: [] }
  });
  const res = makeRes();
  await c.reconciliation(req, res, (e) => { throw e; });
  assert.equal(res._body.ok, true);
  assert.equal(res._body.data.hasDrift, true);
  assert.equal(res._body.data.inventoryDrift.length, 1);
  assert.equal(res._body.data.inventoryDrift[0].type, 'missing_remote');
  assert.ok(res._body.data.recommendations.some((r) => r.action === 'push_inventory'));
});

test('reconciliation: remote reservation not in local → missing_local drift', async () => {
  const req = makeReq({
    channel: 'EXPEDIA',
    local:  { reservations: [] },
    remote: { reservations: [{ id: 'BK-99', status: 'CONFIRMED' }] }
  });
  const res = makeRes();
  await c.reconciliation(req, res, (e) => { throw e; });
  assert.equal(res._body.ok, true);
  assert.equal(res._body.data.reservationDrift[0].type, 'missing_local');
  assert.ok(res._body.data.recommendations.some((r) => r.action === 'ingest_reservation'));
});

test('reconciliation: rate value_mismatch → resync_rate recommendation', async () => {
  const req = makeReq({
    channel: 'BOOKING_COM',
    local:  { rates: [{ key: 'STD|BAR|2026-08-01', rate: 120, currency: 'USD' }] },
    remote: { rates: [{ key: 'STD|BAR|2026-08-01', rate: 130, currency: 'USD' }] }
  });
  const res = makeRes();
  await c.reconciliation(req, res, (e) => { throw e; });
  assert.equal(res._body.data.rateDrift[0].type, 'value_mismatch');
  assert.ok(res._body.data.recommendations.some((r) => r.action === 'resync_rate'));
});

test('reconciliation: channel code uppercased automatically', async () => {
  const req = makeReq({ channel: 'booking_com', local: {}, remote: {} });
  const res = makeRes();
  await c.reconciliation(req, res, (e) => { throw e; });
  assert.equal(res._body.ok, true);
  assert.equal(res._body.data.channel, 'BOOKING_COM');
});

test('reconciliation: counts returned correctly', async () => {
  const req = makeReq({
    channel: 'AIRBNB',
    local:  {
      inventory:    [{ key: 'A', available: 3, stopSell: false }],
      rates:        [{ key: 'B', rate: 100, currency: 'USD' }],
      reservations: []
    },
    remote: { inventory: [], rates: [], reservations: [] }
  });
  const res = makeRes();
  await c.reconciliation(req, res, (e) => { throw e; });
  assert.equal(res._body.data.counts.inventory, 1);
  assert.equal(res._body.data.counts.rate, 1);
  assert.equal(res._body.data.counts.reservation, 0);
});
