'use strict';

/** Phase 18 - Enterprise Platform Layer (IAM, gateway, observability, integration, enterprise). */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPlatformLayer } = require('../src/platform/PlatformLayer');
const { buildInMemoryUserProvider } = require('../src/platform/iam/AuthService');
const { buildPlatformSubscriber } = require('../src/platform/services/platformSubscriber');

function platformWithUsers(users, clock) {
  return buildPlatformLayer({ clock, userProvider: buildInMemoryUserProvider(users) });
}

// ---- IAM -------------------------------------------------------------------
test('AuthService: login -> validate -> refresh -> logout', async () => {
  const p = platformWithUsers([{ username: 'a', password: 'pw', userId: 'u1', roles: ['ADMIN'], properties: ['*'] }]);
  const bad = await p.auth.login({ username: 'a', password: 'wrong' });
  assert.equal(bad.ok, false);
  const s = await p.auth.login({ username: 'a', password: 'pw' });
  assert.equal(s.ok, true);
  assert.equal((await p.auth.validate(s.token)).ok, true);
  const r = await p.auth.refresh(s.refreshToken);
  assert.equal(r.ok, true);
  assert.equal((await p.auth.validate(s.token)).ok, false); // old token invalidated on refresh
  await p.auth.logout(r.token);
  assert.equal((await p.auth.validate(r.token)).ok, false);
});

test('RBAC: wildcard + inheritance + deny-by-default', () => {
  const p = buildPlatformLayer({});
  assert.equal(p.rbac.hasPermission(['FRONT_DESK'], 'reservation.create'), true);
  assert.equal(p.rbac.hasPermission(['FRONT_DESK'], 'billing.post'), false);   // deny by default
  assert.equal(p.rbac.hasPermission(['ADMIN'], 'billing.void'), true);          // admin wildcard
  assert.equal(p.rbac.hasPermission([], 'reservation.read'), false);
});

test('PolicyEngine: property isolation enforced', () => {
  const p = buildPlatformLayer({});
  const principal = { roles: ['FRONT_DESK'], properties: ['PA'] };
  assert.equal(p.policy.evaluate(principal, { permission: 'reservation.read', propertyId: 'PA' }).decision, 'ALLOW');
  assert.equal(p.policy.evaluate(principal, { permission: 'reservation.read', propertyId: 'PB' }).decision, 'DENY');
  assert.equal(p.policy.evaluate({ roles: ['ADMIN'], properties: [] }, { permission: 'billing.x', propertyId: 'PB' }).decision, 'ALLOW');
});

// ---- Gateway ---------------------------------------------------------------
test('APIGateway pipeline: 401 / 403 / 429 / 200 with context', async () => {
  let t = 0;
  const p = platformWithUsers([{ username: 'fd', password: 'pw', userId: 'u1', roles: ['FRONT_DESK'], properties: ['PA'] }], () => t);
  // 401 no token
  assert.equal((await p.gateway.handle({ token: 'nope', permission: 'reservation.read' })).status, 401);
  const s = await p.auth.login({ username: 'fd', password: 'pw' });

  // 403 wrong property
  assert.equal((await p.gateway.handle({ token: s.token, permission: 'reservation.read', propertyId: 'PB' })).status, 403);

  // 200 allowed + context injected
  const okRes = await p.gateway.handle({ token: s.token, permission: 'reservation.read', propertyId: 'PA', endpointCategory: 'res' },
    async (ctx) => ({ seen: ctx.propertyId }));
  assert.equal(okRes.status, 200);
  assert.equal(okRes.context.propertyId, 'PA');
  assert.equal(okRes.context.userId, 'u1');

  // 429 after exceeding the limit
  let limited = false;
  for (let i = 0; i < 5; i++) {
    const r = await p.gateway.handle({ token: s.token, permission: 'reservation.read', propertyId: 'PA', endpointCategory: 'res', rateLimit: { limit: 2, windowMs: 1000 } }, async () => ({}));
    if (r.status === 429) limited = true;
  }
  assert.ok(limited, 'rate limit kicks in');
});

// ---- Observability ---------------------------------------------------------
test('Log/Metrics/Trace/Audit behave + audit is immutable', async () => {
  const p = buildPlatformLayer({});
  p.log.info({ eventType: 'x', module: 'm', correlationId: 'c1' });
  assert.equal(p.log.query({ correlationId: 'c1' }).length, 1);

  p.metrics.increment('req', 1, { m: 'res' });
  p.metrics.timing('lat', 12);
  const snap = p.metrics.snapshot();
  assert.equal(snap.counters['req{m=res}'], 1);
  assert.equal(snap.timings.lat.count, 1);

  p.trace.start('t1', { correlationId: 'c1' });
  p.trace.span('t1', 'db', { module: 'billing' });
  p.trace.end('t1');
  assert.equal(p.trace.getTrace('t1').spans.length, 1);

  const rec = await p.audit.ingest({ type: 'billing.posted', propertyId: 'PA' });
  assert.throws(() => { rec.type = 'tampered'; });          // frozen / immutable
  assert.equal(p.audit.list({ propertyId: 'PA' }).length, 1);
  assert.equal(typeof p.audit.list().find((e) => e.id === rec.id).id, 'string');
});

// ---- Integration -----------------------------------------------------------
test('WebhookEngine: signature verification, idempotency, retry queue', async () => {
  const p = buildPlatformLayer({});
  const payload = { booking: 'BC-1' };
  const secret = 's3cr3t';
  const sig = p.webhooks.sign(payload, secret);

  assert.equal(p.webhooks.receive({ source: 'booking.com', payload, signature: 'bad', secret }).ok, false);
  const first = p.webhooks.receive({ source: 'booking.com', payload, signature: sig, secret, idempotencyKey: 'K1' });
  assert.equal(first.ok, true);
  const dup = p.webhooks.receive({ source: 'booking.com', payload, signature: sig, secret, idempotencyKey: 'K1' });
  assert.equal(dup.deduped, true);

  // retry: handler fails twice then the engine dead-letters after maxAttempts
  let calls = 0;
  await p.webhooks.processQueue(async () => { calls += 1; throw new Error('boom'); });
  assert.ok(calls >= 1);
  assert.ok(p.webhooks.deadLetters().length === 1);
});

test('IntegrationAdapterEngine: contract validation + isolation', () => {
  const p = buildPlatformLayer({});
  const good = { name: 'bcom', async syncReservations() {}, async pushRates() {}, async pushAvailability() {}, async pullBookings() { return []; } };
  assert.equal(p.adapters.register(good), 'bcom');
  assert.throws(() => p.adapters.register({ name: 'bad' }), /missing/);
  assert.throws(() => p.adapters.get('nope'), /unknown_adapter/);
});

// ---- Enterprise ------------------------------------------------------------
test('Enterprise: property registry, config feature toggle, cross-property analytics', () => {
  const p = buildPlatformLayer({});
  p.properties.register({ propertyId: 'PA', name: 'Alpha', timezone: 'Asia/Colombo' });
  p.properties.register({ propertyId: 'PB', name: 'Beta' });
  assert.equal(p.properties.list().length, 2);
  assert.equal(p.properties.get('PA').timezone, 'Asia/Colombo');

  p.config.setFeature('dynamic_pricing', true);
  assert.equal(p.config.isFeatureEnabled('dynamic_pricing'), true);
  assert.equal(p.config.isFeatureEnabled('unknown'), false);

  p.analytics.record('PA', { occupancy: 0.8, revenue: 1000, demand: 60 });
  p.analytics.record('PB', { occupancy: 0.4, revenue: 400, demand: 30 });
  const agg = p.analytics.aggregate();
  assert.equal(agg.totalRevenue, 1400);
  assert.equal(agg.topPerformer, 'PA');
});

test('platform subscriber aggregates events read-only', async () => {
  const eventBus = require('../src/core/eventBus');
  eventBus.reset();
  eventBus.init({ db: { auditRows: [], async insertAuditEvent(ev) { this.auditRows.push(ev); } } });
  const p = buildPlatformLayer({});
  buildPlatformSubscriber({ eventBus, platform: p });

  await eventBus.publish({ event_type: 'reservation.created', property_id: 'PA', actor_id: 'u1', request_id: 'r1', payload: {} });
  await eventBus.publish({ event_type: 'invoice.finalized', property_id: 'PA', request_id: 'r2', payload: { total: 250 } });

  assert.ok(p.audit.list({ propertyId: 'PA' }).length >= 2);
  assert.equal(p.metrics.snapshot().counters['events_total{type=reservation.created}'], 1);
  assert.equal(p.analytics.aggregate().totalRevenue, 250);
});
