import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServices } from '../src/services/index.js';

function recorder() {
  const calls = [];
  const rec = (m) => (p, a, b) => { calls.push({ m, p, body: m === 'GET' || m === 'DELETE' ? undefined : a, opts: m === 'GET' || m === 'DELETE' ? a : b }); return Promise.resolve({ ok: true }); };
  return { calls, get: rec('GET'), post: rec('POST'), put: rec('PUT'), del: rec('DELETE') };
}

test('services map to existing backend routes (method + path)', async () => {
  const api = recorder();
  const s = createServices(api);
  await s.auth.login({});
  await s.reservations.list({ status: 'CONFIRMED' });
  await s.reservations.byNumber('NEG-2026-000001');
  await s.reservations.create({});
  await s.reservations.checkIn('r1', 'room1');
  await s.reservations.checkOut('r1', true);
  await s.guests.list({});
  await s.rooms.list({});
  await s.billing.invoices({});
  await s.billing.postCharge('f1', {});
  await s.housekeeping.createTask({});
  await s.nightAudit.run({});
  await s.revenue.kpis({});
  await s.finance.costCenters({});
  await s.channel.status();
  await s.channel.control();
  await s.booking.create({});
  await s.platform.metrics();

  const byPath = api.calls.map((c) => `${c.m} ${c.p}`);
  assert.ok(byPath.includes('POST /auth/login'));
  assert.ok(byPath.includes('GET /pms/reservations'));
  assert.ok(byPath.includes('GET /pms/reservations/number/NEG-2026-000001'));
  assert.ok(byPath.includes('POST /pms/reservations'));
  assert.ok(byPath.includes('POST /pms/reservations/r1/checkin'));
  assert.ok(byPath.includes('POST /pms/reservations/r1/checkout'));
  assert.ok(byPath.includes('GET /pms/guests'));
  assert.ok(byPath.includes('GET /pms/rooms'));
  assert.ok(byPath.includes('GET /pms/invoices'));
  assert.ok(byPath.includes('POST /pms/folios/f1/charges'));
  assert.ok(byPath.includes('POST /pms/housekeeping/tasks'));
  assert.ok(byPath.includes('POST /pms/night-audit/run'));
  assert.ok(byPath.includes('GET /revenue/kpis'));
  assert.ok(byPath.includes('GET /finance/cost-centers'));
  assert.ok(byPath.includes('GET /channel/status'));
  assert.ok(byPath.includes('GET /channel/control'));
  assert.ok(byPath.includes('POST /booking/create'));
  assert.ok(byPath.includes('GET /platform/admin/metrics'));
});

test('every service path targets a known mounted prefix', async () => {
  const api = recorder();
  const s = createServices(api);
  // exercise a broad spread of calls
  await Promise.all([
    s.auth.me(), s.auth.properties(), s.auth.switchProperty('p1'),
    s.reservations.confirm('r'), s.reservations.cancel('r', 'x'), s.reservations.noShow('r'),
    s.groups.byId('g'), s.guests.byId('x'), s.guests.create({}),
    s.rooms.roomTypes(), s.rooms.setStatus('r', 'OCCUPIED'),
    s.availability.byDate({}), s.availability.calendar({}),
    s.ratePlans.list(), s.mealPlans.list(), s.childPolicies.list(),
    s.billing.cashPayment('f', {}), s.billing.closeFolio('f', false), s.billing.allocations('f'),
    s.vouchers.byNumber('v'), s.housekeeping.assignTask('t', 'u'),
    s.revenue.rateGrid({}), s.revenue.override({}),
    s.finance.ledgerByReference({}), s.finance.reportRevenue({}),
    s.channel.syncRates({}), s.platform.audit({}), s.platform.properties(),
    s.booking.create({}), s.booking.update('r1', {}), s.booking.cancel('r1', {})
  ]);
  const allowed = /^\/(auth|pms|finance|revenue|channel|platform|booking)\//;
  for (const c of api.calls) assert.ok(allowed.test(c.p), 'unexpected path: ' + c.p);
});
