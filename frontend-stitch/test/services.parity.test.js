import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServices } from '../src/services/index.js';

// Phase 36 - service-layer parity. Asserts the newly wired back-office + gap
// closure methods map to the correct backend method + path, and that every
// service call targets a known mounted /api prefix (no stale groups).

function recorder() {
  const calls = [];
  const rec = (m) => (p) => { calls.push({ m, p }); return Promise.resolve({ ok: true }); };
  return { calls, get: rec('GET'), post: rec('POST'), put: rec('PUT'), del: rec('DELETE') };
}

test('Phase 36 new methods map to correct method + path', async () => {
  const api = recorder();
  const s = createServices(api);
  await Promise.all([
    // gap-closure on existing groups
    s.reservations.update('r1', {}), s.reservations.roomMove('r1', 'room9'),
    s.frontdesk.arrivals({}), s.frontdesk.departures({}), s.frontdesk.inhouse({}),
    s.billing.folios({}), s.billing.folioById('f1'),
    s.housekeeping.tasks({}), s.housekeeping.roomStatus({}),
    s.nightAudit.status({}), s.nightAudit.history({}),
    // new back-office groups
    s.iam.users(), s.iam.roles(), s.iam.register({}),
    s.settings.schema('pms'), s.settings.list('pms'), s.settings.get('pms', 'x'), s.settings.set('pms', 'x', 1, 'tenant'), s.settings.remove('pms', 'x', 'tenant'),
    s.jobs.schedule({}), s.jobs.cancel('j1'), s.jobs.run(5),
    s.notifications.list({}), s.notifications.byId('n1'), s.notifications.request({}), s.notifications.sendPending(),
    s.webhooks.list(), s.webhooks.register({}), s.webhooks.disable('w1'), s.webhooks.deliverPending(),
    s.files.byId('x1'), s.files.token('x1'), s.files.remove('x1'),
    s.connectors.list(), s.connectors.config('stripe'), s.connectors.configure('stripe', {}), s.connectors.probe('stripe'), s.connectors.health('stripe')
  ]);
  const paths = api.calls.map((c) => `${c.m} ${c.p}`);
  for (const expected of [
    'PUT /pms/reservations/r1', 'POST /pms/reservations/r1/room-move',
    'GET /pms/frontdesk/arrivals', 'GET /pms/frontdesk/departures', 'GET /pms/frontdesk/inhouse',
    'GET /pms/folios', 'GET /pms/folios/f1',
    'GET /pms/housekeeping/tasks', 'GET /pms/housekeeping/room-status',
    'GET /pms/night-audit/status', 'GET /pms/night-audit/history',
    'GET /iam/users', 'GET /iam/roles', 'POST /auth/register',
    'GET /settings/pms', 'PUT /settings/pms/x', 'DELETE /settings/pms/x',
    'POST /jobs', 'DELETE /jobs/j1', 'POST /jobs/run',
    'GET /notifications', 'GET /notifications/n1', 'POST /notifications', 'POST /notifications/send/run',
    'GET /webhooks', 'POST /webhooks', 'DELETE /webhooks/w1', 'POST /webhooks/deliveries/run',
    'GET /files/x1', 'GET /files/x1/token', 'DELETE /files/x1',
    'GET /connectors', 'GET /connectors/stripe/config', 'PUT /connectors/stripe/config', 'POST /connectors/stripe/probe', 'POST /connectors/stripe/health'
  ]) assert.ok(paths.includes(expected), 'missing/incorrect: ' + expected);
});

test('all Phase 36 paths target known mounted backend prefixes', async () => {
  const api = recorder();
  const s = createServices(api);
  await Promise.all([
    s.iam.users(), s.settings.schema(), s.jobs.run(), s.notifications.list({}),
    s.webhooks.list(), s.files.byId('x'), s.connectors.list(),
    s.frontdesk.arrivals({}), s.housekeeping.tasks({}), s.nightAudit.status({})
  ]);
  const allowed = /^\/(auth|pms|finance|revenue|channel|platform|booking|iam|settings|jobs|notifications|webhooks|files|connectors)(\/|$)/;
  for (const c of api.calls) assert.ok(allowed.test(c.p), 'unexpected/stale path: ' + c.p);
});
