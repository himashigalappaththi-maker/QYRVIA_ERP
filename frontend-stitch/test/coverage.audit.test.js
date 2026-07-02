import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServices } from '../src/services/index.js';

// Phase 35 - coverage-audit guard. Locks in the critical-workflow API wiring
// documented in docs/workflow-validation.md so it cannot silently regress before
// the Phase 36 Stitch migration. Pure wiring assertions (no network).

function recorder() {
  const calls = [];
  const rec = (m) => (p, a, b) => {
    calls.push({ m, p });
    return Promise.resolve({ ok: true });
  };
  return { calls, get: rec('GET'), post: rec('POST'), put: rec('PUT'), del: rec('DELETE') };
}

test('reservation -> check-in -> billing -> checkout chain is fully wired', async () => {
  const api = recorder();
  const s = createServices(api);
  await s.reservations.create({});
  await s.reservations.confirm('r1');
  await s.reservations.checkIn('r1', 'room1');
  await s.billing.postCharge('f1', {});
  await s.billing.cashPayment('f1', {});
  await s.billing.issueInvoice({});
  await s.reservations.checkOut('r1', false);

  const paths = api.calls.map((c) => `${c.m} ${c.p}`);
  for (const expected of [
    'POST /pms/reservations',
    'POST /pms/reservations/r1/confirm',
    'POST /pms/reservations/r1/checkin',
    'POST /pms/folios/f1/charges',
    'POST /pms/folios/f1/payments/cash',
    'POST /pms/invoices/issue',
    'POST /pms/reservations/r1/checkout'
  ]) assert.ok(paths.includes(expected), 'missing chain step: ' + expected);
});

test('housekeeping + night-audit lifecycle methods are wired', async () => {
  const api = recorder();
  const s = createServices(api);
  await s.housekeeping.createTask({});
  await s.housekeeping.assignTask('t1', 'u1');
  await s.housekeeping.completeTask('t1', {});
  await s.nightAudit.run({});
  await s.nightAudit.schedule({});
  const paths = api.calls.map((c) => `${c.m} ${c.p}`);
  for (const expected of [
    'POST /pms/housekeeping/tasks',
    'POST /pms/housekeeping/tasks/t1/assign',
    'POST /pms/housekeeping/tasks/t1/complete',
    'POST /pms/night-audit/run',
    'POST /pms/night-audit/schedule'
  ]) assert.ok(paths.includes(expected), 'missing lifecycle step: ' + expected);
});

test('channel/OTA + booking-engine flow is wired', async () => {
  const api = recorder();
  const s = createServices(api);
  await Promise.all([
    s.channel.status(), s.channel.control(),
    s.channel.syncRates({}), s.channel.syncInventory({}), s.channel.syncBookings({}),
    s.booking.create({}), s.booking.update('b1', {}), s.booking.cancel('b1', {})
  ]);
  const paths = api.calls.map((c) => `${c.m} ${c.p}`);
  for (const expected of [
    'GET /channel/status', 'GET /channel/control',
    'POST /channel/sync/rates', 'POST /channel/sync/inventory', 'POST /channel/bookings/sync',
    'POST /booking/create', 'POST /booking/update/b1', 'POST /booking/cancel/b1'
  ]) assert.ok(paths.includes(expected), 'missing channel/booking step: ' + expected);
});

test('every service call targets a known mounted backend prefix (no stale groups)', async () => {
  const api = recorder();
  const s = createServices(api);
  // Exercise every defined service method (incl. dormant ones) to catch any path
  // pointing at a prefix the backend does not mount.
  await Promise.all([
    s.auth.me(), s.auth.properties(), s.auth.switchProperty('p'),
    s.reservations.list({}), s.reservations.byNumber('n'), s.reservations.noShow('r'),
    s.groups.create({}), s.groups.byId('g'), s.groups.roomingList('g'), s.groups.addRoom('g', 'r'), s.groups.cancelAll('g', 'x', false), s.groups.checkinAll('g'),
    s.guests.list({}), s.guests.byId('x'), s.guests.create({}), s.guests.blacklist('x', true),
    s.rooms.list({}), s.rooms.byNumber('1'), s.rooms.create({}), s.rooms.setStatus('r', 'X'), s.rooms.activate('r'), s.rooms.deactivate('r'), s.rooms.roomTypes(), s.rooms.createRoomType({}), s.rooms.features(), s.rooms.createFeature({}), s.rooms.attachFeature('r', 'f'),
    s.availability.byDate({}), s.availability.calendar({}),
    s.ratePlans.list(), s.ratePlans.byId('r'), s.ratePlans.create({}), s.ratePlans.attachMealPlan('r', 'm'),
    s.mealPlans.list(), s.mealPlans.byId('m'), s.mealPlans.create({}),
    s.childPolicies.list(), s.childPolicies.byId('c'),
    s.billing.invoices({}), s.billing.invoiceById('i'), s.billing.invoiceByNumber('n'), s.billing.issueInvoice({}), s.billing.voidInvoice('i', 'x'), s.billing.postCharge('f', {}), s.billing.cashPayment('f', {}), s.billing.closeFolio('f', false), s.billing.allocations('f', 'p'), s.billing.allocate('f', 'p', {}),
    s.vouchers.byNumber('v'), s.vouchers.issue({}), s.vouchers.redeem('v', 'r'), s.vouchers.cancel('v', 'x'),
    s.housekeeping.createTask({}), s.housekeeping.assignTask('t', 'u'), s.housekeeping.completeTask('t', {}),
    s.nightAudit.run({}), s.nightAudit.schedule({}),
    s.revenue.rate({}), s.revenue.rateGrid({}), s.revenue.forecast({}), s.revenue.kpis({}), s.revenue.dashboard({}), s.revenue.setRatePlan({}), s.revenue.override({}),
    s.finance.costCenters({}), s.finance.costCenterById('c'), s.finance.createCostCenter({}), s.finance.updateCostCenter('c', {}), s.finance.disableCostCenter('c'), s.finance.revenueMap(), s.finance.upsertRevenueMap({}), s.finance.deleteRevenueMap({}), s.finance.ledgerByReference({}), s.finance.postLedger({}), s.finance.validateLedger({}), s.finance.revertLedger({}), s.finance.reportCostCenter({}), s.finance.reportRevenue({}),
    s.channel.status(), s.channel.control(), s.channel.syncRates({}), s.channel.syncInventory({}), s.channel.syncBookings({}), s.channel.confirmBooking({}), s.channel.cancelBooking({}),
    s.booking.create({}), s.booking.update('b', {}), s.booking.cancel('b', {}),
    s.platform.metrics(), s.platform.logs({}), s.platform.audit({}), s.platform.integrations(), s.platform.properties(), s.platform.analytics(), s.platform.config()
  ]);
  const allowed = /^\/(auth|pms|finance|revenue|channel|platform|booking)\//;
  for (const c of api.calls) assert.ok(allowed.test(c.p), 'unexpected/stale path: ' + c.p);
});
