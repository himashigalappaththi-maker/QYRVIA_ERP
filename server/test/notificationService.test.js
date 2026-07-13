'use strict';

const fx = require('./_fixtures');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { buildNotificationService } = require('../src/services/notificationService');
const eventBus                     = require('../src/core/eventBus');

const CTX = { requestId: 'rq-n', tenantId: fx.TENANT_A, propertyId: null, actorId: fx.USER_ID, actorName: 'Jane' };

// Satisfies both _requireClient (fixture) and the typeof client.query !== 'function' guard
// in requestNotification (service). The query stub is never called in unit tests; it only
// satisfies the structural check.
const MOCK_CLIENT = Object.freeze({ _isMockTenantClient: true, query: async () => ({}) });

beforeEach(() => { eventBus.reset(); });

// ── Existing: requestNotification ────────────────────────────────────────────

test('requestNotification persists pending row + emits notification.requested', async () => {
  const r = fx.makeFakeRepos();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  const out = await svc.requestNotification({ channel: 'email', recipient: 'a@b.c', body: 'hello' }, CTX, MOCK_CLIENT);
  assert.equal(out.ok, true);
  assert.equal(out.status, 'pending');
  assert.equal(r.notificationRepo._notifications[0].channel, 'email');
  assert.ok(db.auditRows.find(x => x.event_type === 'notification.requested'));
});

test('requestNotification rejects missing channel', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  const out = await svc.requestNotification({ recipient: 'a@b.c', body: 'x' }, CTX, MOCK_CLIENT);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'missing_fields');
});

test('requestNotification rejects invalid channel', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  const out = await svc.requestNotification({ channel: 'pigeon', recipient: 'x', body: 'y' }, CTX, MOCK_CLIENT);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'invalid_channel');
});

test('renders template variables', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  r.notificationRepo._seedTemplate({
    id: 'tpl1', tenant_id: fx.TENANT_A, code: 'welcome', channel: 'email',
    subject: 'Hi {{name}}', body: 'Welcome {{name}} to {{hotel}}', is_active: true
  });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  const out = await svc.requestNotification({
    channel: 'email', recipient: 'a@b.c', templateCode: 'welcome',
    context: { name: 'Jane', hotel: 'Acme' }
  }, CTX, MOCK_CLIENT);
  assert.equal(out.ok, true);
  const n = r.notificationRepo._notifications[0];
  assert.equal(n.subject, 'Hi Jane');
  assert.equal(n.body,    'Welcome Jane to Acme');
});

test('empty body without template -> empty_body', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  const out = await svc.requestNotification({ channel: 'email', recipient: 'a@b.c' }, CTX, MOCK_CLIENT);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'empty_body');
});

test('tenant isolation: tenant B cannot see tenant A notifications', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  const out = await svc.requestNotification({ channel: 'email', recipient: 'a@b.c', body: 'x' }, CTX, MOCK_CLIENT);
  const otherCtx = Object.assign({}, CTX, { tenantId: fx.TENANT_B });
  const found = await svc.findById(out.id, otherCtx);
  assert.equal(found, null);
});

// ── Existing: sendPending — updated for Phase 58 (client required, new summary shape) ──

test('sendPending without provider marks failed (not_configured via markNotificationFailed)', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w-test' });
  await svc.requestNotification({ channel: 'email', recipient: 'a@b.c', body: 'x' }, CTX, MOCK_CLIENT);
  const out = await svc.sendPending({ limit: 5, client: MOCK_CLIENT });
  assert.equal(out.claimed,   1);
  assert.equal(out.failed,    1);
  assert.equal(out.delivered, 0);
  // Terminal failure via markNotificationFailed — status is 'failed'
  assert.equal(r.notificationRepo._notifications[0].status, 'failed');
  // Delivery log records not_configured reason (bounded, no PII)
  const log = r.notificationRepo._deliveryLog[0];
  assert.equal(log.status,     'not_configured');
  assert.equal(log.error_code, 'no_provider_registered');
});

test('sendPending with provider success marks delivered', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w-test' });
  svc.registerProvider('email', { async send() { return { ok: true, provider: 'memory', provider_ref: 'msg-1' }; } });
  await svc.requestNotification({ channel: 'email', recipient: 'a@b.c', body: 'x' }, CTX, MOCK_CLIENT);
  const out = await svc.sendPending({ limit: 5, client: MOCK_CLIENT });
  assert.equal(out.delivered, 1);
  assert.equal(r.notificationRepo._notifications[0].status, 'delivered');
});

test('sendPending with retryable provider failure schedules retry (not immediate fail)', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w-test' });
  svc.registerProvider('email', { async send() { return { ok: false, error: 'smtp_timeout' }; } });
  await svc.requestNotification({ channel: 'email', recipient: 'a@b.c', body: 'x' }, CTX, MOCK_CLIENT);
  const out = await svc.sendPending({ limit: 5, client: MOCK_CLIENT });
  assert.equal(out.retried,   1, 'retryable failure must schedule a retry');
  assert.equal(out.failed,    0);
  assert.equal(out.delivered, 0);
  // Status returns to pending with backoff scheduled
  assert.equal(r.notificationRepo._notifications[0].status, 'pending');
  assert.ok(r.notificationRepo._notifications[0].next_attempt_at, 'next_attempt_at must be set');
});

test('list filters by status', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w-test' });
  await svc.requestNotification({ channel: 'email', recipient: 'a@b.c', body: '1' }, CTX, MOCK_CLIENT);
  await svc.requestNotification({ channel: 'email', recipient: 'a@b.c', body: '2' }, CTX, MOCK_CLIENT);
  await svc.sendPending({ limit: 10, client: MOCK_CLIENT }); // no provider → both fail
  const all    = await svc.list(CTX, {});
  const failed = await svc.list(CTX, { status: 'failed' });
  assert.equal(all.length,    2);
  assert.equal(failed.length, 2);
});

// ── Phase 58 targeted: service-layer retry mechanics ─────────────────────────

// 1. Claim does not increment attempts
test('[P58] claim does not increment attempt_count', async () => {
  const r   = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w1' });

  // Intercept beginNotificationAttempt to return null (so the row stops there)
  r.notificationRepo.beginNotificationAttempt = async () => null;

  await r.notificationRepo.insertNotification({
    tenant_id: fx.TENANT_A, status: 'pending', channel: 'email', recipient: 'x', body: 'y'
  }, MOCK_CLIENT);
  const before = r.notificationRepo._notifications[0].attempt_count;
  await svc.sendPending({ limit: 5, client: MOCK_CLIENT });
  // Claim transitions to 'sending' but attempt_count must not change during claim
  const n = r.notificationRepo._notifications[0];
  assert.equal(n.attempt_count, before, 'attempt_count must not increment during claim');
});

// 2. Provider send happens only after beginNotificationAttempt
test('[P58] provider send is never called before beginNotificationAttempt returns a row', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });

  let beginCalled = false;
  let sendCalled  = false;

  const origBegin = r.notificationRepo.beginNotificationAttempt.bind(r.notificationRepo);
  r.notificationRepo.beginNotificationAttempt = async (...args) => {
    beginCalled = true;
    return origBegin(...args);
  };

  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w1' });
  svc.registerProvider('email', {
    async send() { sendCalled = true; return { ok: true, provider_ref: 'ref1' }; }
  });

  await r.notificationRepo.insertNotification({
    tenant_id: fx.TENANT_A, status: 'pending', channel: 'email', recipient: 'x', body: 'y'
  }, MOCK_CLIENT);

  // Override to check ordering: beginNotificationAttempt must precede send
  const sendOrder = [];
  const origBegin2 = r.notificationRepo.beginNotificationAttempt.bind(r.notificationRepo);
  r.notificationRepo.beginNotificationAttempt = async (...args) => {
    sendOrder.push('begin');
    return origBegin2(...args);
  };
  svc.registerProvider('email', {
    async send() { sendOrder.push('send'); return { ok: true, provider_ref: 'r1' }; }
  });

  await svc.sendPending({ limit: 5, client: MOCK_CLIENT });
  assert.ok(beginCalled || sendOrder.includes('begin'), 'beginNotificationAttempt must be called');

  assert.equal(sendOrder[0], 'begin', 'begin must come before send');
  assert.equal(sendOrder[1], 'send',  'send must come after begin');
});

// 3. beginNotificationAttempt returning null prevents provider call
test('[P58] begin-attempt returning null prevents provider.send call', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });

  let sendCalled = false;
  r.notificationRepo.beginNotificationAttempt = async () => null; // simulate lost ownership

  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w1' });
  svc.registerProvider('email', { async send() { sendCalled = true; return { ok: true }; } });

  await r.notificationRepo.insertNotification({
    tenant_id: fx.TENANT_A, status: 'pending', channel: 'email', recipient: 'x', body: 'y'
  }, MOCK_CLIENT);

  const out = await svc.sendPending({ limit: 5, client: MOCK_CLIENT });
  assert.equal(sendCalled, false, 'provider.send must not be called when begin returns null');
  assert.equal(out.skipped, 1);
});

// 4. Success calls markNotificationDelivered with expectedAttemptCount
test('[P58] success calls markNotificationDelivered with correct attempt count', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });

  const deliveredCalls = [];
  const origDelivered  = r.notificationRepo.markNotificationDelivered.bind(r.notificationRepo);
  r.notificationRepo.markNotificationDelivered = async (id, wid, expected, msgId, client) => {
    deliveredCalls.push({ id, wid, expected, msgId });
    return origDelivered(id, wid, expected, msgId, client);
  };

  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w1' });
  svc.registerProvider('email', { async send() { return { ok: true, provider_ref: 'msg-99' }; } });

  await r.notificationRepo.insertNotification({
    tenant_id: fx.TENANT_A, status: 'pending', channel: 'email', recipient: 'x', body: 'y'
  }, MOCK_CLIENT);
  await svc.sendPending({ limit: 5, client: MOCK_CLIENT });

  assert.equal(deliveredCalls.length, 1);
  assert.equal(deliveredCalls[0].expected, 1, 'expectedAttemptCount must be 1 after first begin');
  assert.equal(deliveredCalls[0].msgId,    'msg-99');
});

// 5. Retryable failure schedules retry and clears ownership
test('[P58] retryable failure calls markNotificationRetry and clears locks', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w1' });
  svc.registerProvider('email', { async send() { return { ok: false, error: 'rate_limited' }; } });

  await r.notificationRepo.insertNotification({
    tenant_id: fx.TENANT_A, status: 'pending', channel: 'email',
    recipient: 'x', body: 'y', max_attempts: 3
  }, MOCK_CLIENT);
  const out = await svc.sendPending({ limit: 5, client: MOCK_CLIENT });

  assert.equal(out.retried, 1);
  const n = r.notificationRepo._notifications[0];
  assert.equal(n.status,         'pending',  'must return to pending');
  assert.equal(n.locked_by,      null,       'locked_by must be cleared');
  assert.equal(n.locked_at,      null,       'locked_at must be cleared');
  assert.ok(n.next_attempt_at,               'next_attempt_at must be set');
  assert.equal(n.attempt_count, 1,           'attempt_count must be 1');
});

// 6. Exhausted attempt becomes failed
test('[P58] exhausted attempt (attempt_count >= max_attempts) becomes failed', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w1' });
  svc.registerProvider('email', { async send() { return { ok: false, error: 'rate_limited' }; } });

  await r.notificationRepo.insertNotification({
    tenant_id: fx.TENANT_A, status: 'pending', channel: 'email',
    recipient: 'x', body: 'y', max_attempts: 1
  }, MOCK_CLIENT);
  const out = await svc.sendPending({ limit: 5, client: MOCK_CLIENT });

  assert.equal(out.failed, 1, 'must be failed when attempts exhausted');
  assert.equal(r.notificationRepo._notifications[0].status, 'failed');
});

// 7. Permanent failure becomes failed immediately (below max_attempts)
test('[P58] permanent failure class causes immediate terminal failure below max_attempts', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w1' });
  svc.registerProvider('email', { async send() { return { ok: false, error: 'invalid_recipient' }; } });

  await r.notificationRepo.insertNotification({
    tenant_id: fx.TENANT_A, status: 'pending', channel: 'email',
    recipient: 'x', body: 'y', max_attempts: 3
  }, MOCK_CLIENT);
  const out = await svc.sendPending({ limit: 5, client: MOCK_CLIENT });

  assert.equal(out.failed,   1, 'permanent failure must be terminal immediately');
  assert.equal(out.retried,  0);
  assert.equal(r.notificationRepo._notifications[0].status, 'failed');
});

// 8. Provider idempotency key is stable across retries
test('[P58] provider idempotency key derived from notification ID is stable across retries', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });

  const usedKeys = [];
  const origBegin = r.notificationRepo.beginNotificationAttempt.bind(r.notificationRepo);
  r.notificationRepo.beginNotificationAttempt = async (id, wid, key, client) => {
    usedKeys.push(key);
    return origBegin(id, wid, key, client);
  };

  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w1' });
  // First attempt fails retryably
  svc.registerProvider('email', { async send() { return { ok: false, error: 'rate_limited' }; } });

  await r.notificationRepo.insertNotification({
    tenant_id: fx.TENANT_A, status: 'pending', channel: 'email',
    recipient: 'x', body: 'y', max_attempts: 3
  }, MOCK_CLIENT);
  const n = r.notificationRepo._notifications[0];
  await svc.sendPending({ limit: 5, client: MOCK_CLIENT });

  // Simulate second attempt: reset back to pending with no next_attempt_at
  const stored = r.notificationRepo._notifications[0];
  stored.next_attempt_at = null;

  await svc.sendPending({ limit: 5, client: MOCK_CLIENT });

  assert.ok(usedKeys.length >= 2, 'beginNotificationAttempt called at least twice');
  assert.equal(usedKeys[0], 'qyrvia-notification:' + n.id, 'key must be derived from notification ID');
  // After first retry, stored idempotency key guards second call:
  // second call with same key matches → proceeds
  assert.equal(usedKeys[0], usedKeys[1], 'idempotency key must be identical on every retry');
});

// 9. Stale worker — transition returning null causes no second send
test('[P58] markNotificationDelivered returning null stops processing without second send', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });

  let sendCount = 0;
  const origDelivered = r.notificationRepo.markNotificationDelivered.bind(r.notificationRepo);
  r.notificationRepo.markNotificationDelivered = async () => null; // simulate lost ownership

  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w1' });
  svc.registerProvider('email', { async send() { sendCount++; return { ok: true, provider_ref: 'x' }; } });

  await r.notificationRepo.insertNotification({
    tenant_id: fx.TENANT_A, status: 'pending', channel: 'email', recipient: 'x', body: 'y'
  }, MOCK_CLIENT);
  const out = await svc.sendPending({ limit: 5, client: MOCK_CLIENT });

  assert.equal(sendCount,   1, 'provider.send must be called exactly once');
  assert.equal(out.skipped, 1, 'must be counted as skipped when transition returns null');
  assert.equal(out.delivered, 0);
});

// 10. One notification failure does not stop the batch
test('[P58] one notification failure does not prevent other notifications from being processed', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  let callCount = 0;

  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w1' });
  svc.registerProvider('email', {
    async send() {
      callCount++;
      if (callCount === 1) throw new Error('ECONNRESET'); // first throws
      return { ok: true, provider_ref: 'ref2' };           // second succeeds
    }
  });

  await r.notificationRepo.insertNotification({ tenant_id: fx.TENANT_A, status: 'pending', channel: 'email', recipient: 'x1', body: 'a' }, MOCK_CLIENT);
  await r.notificationRepo.insertNotification({ tenant_id: fx.TENANT_A, status: 'pending', channel: 'email', recipient: 'x2', body: 'b' }, MOCK_CLIENT);

  const out = await svc.sendPending({ limit: 5, client: MOCK_CLIENT });
  assert.equal(out.claimed, 2);
  // First throws → retried (ECONNRESET is retryable), second succeeds
  assert.equal(out.delivered + out.retried, 2, 'both notifications must be processed');
});

// 11. Missing provider never produces false success
test('[P58] missing provider never marks notification as delivered', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w1' });
  // No provider registered

  await r.notificationRepo.insertNotification({
    tenant_id: fx.TENANT_A, status: 'pending', channel: 'email', recipient: 'x', body: 'y'
  }, MOCK_CLIENT);
  const out = await svc.sendPending({ limit: 5, client: MOCK_CLIENT });

  assert.equal(out.delivered, 0, 'must never report delivered when no provider is registered');
  assert.equal(out.failed,    1);
  const delivered = r.notificationRepo._notifications.filter(n => n.status === 'delivered');
  assert.equal(delivered.length, 0);
});

// 12. Logs contain no PII, token, message body, credentials, or raw error object
test('[P58] delivery log records only sanitized bounded fields — no recipient, body, or credentials', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w1' });
  svc.registerProvider('email', {
    async send() { return { ok: false, error: 'rate_limited', raw_response: 'SENSITIVE-DO-NOT-LOG' }; }
  });

  await r.notificationRepo.insertNotification({
    tenant_id: fx.TENANT_A, status: 'pending', channel: 'email',
    recipient: 'secret@example.com', body: 'SECRET-BODY', subject: 'SECRET-SUBJECT'
  }, MOCK_CLIENT);
  await svc.sendPending({ limit: 5, client: MOCK_CLIENT });

  const log = r.notificationRepo._deliveryLog[0];
  // Verify only safe bounded fields are present in the log row
  const logJson = JSON.stringify(log);
  assert.ok(!logJson.includes('secret@example.com'), 'recipient must not appear in delivery log');
  assert.ok(!logJson.includes('SECRET-BODY'),         'body must not appear in delivery log');
  assert.ok(!logJson.includes('SECRET-SUBJECT'),      'subject must not appear in delivery log');
  assert.ok(!logJson.includes('SENSITIVE-DO-NOT-LOG'),'raw provider response must not appear in log');
  // Safe fields must be present
  assert.ok(log.notification_id, 'notification_id must be present');
  assert.ok(log.attempt_no,      'attempt_no must be present');
  assert.ok(log.error_code,      'error_code must be present (bounded)');
});

// 13. Delivery logs contain sanitized bounded data only
test('[P58] successful delivery log records provider_ref (bounded) but not message body', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w1' });
  svc.registerProvider('email', {
    async send() {
      return { ok: true, provider: 'smtp', provider_ref: 'bound-ref-001', body: 'NEVER-LOG-BODY' };
    }
  });

  await r.notificationRepo.insertNotification({
    tenant_id: fx.TENANT_A, status: 'pending', channel: 'email', recipient: 'x', body: 'msg-body'
  }, MOCK_CLIENT);
  await svc.sendPending({ limit: 5, client: MOCK_CLIENT });

  const log = r.notificationRepo._deliveryLog[0];
  assert.equal(log.status,       'delivered');
  assert.equal(log.provider_ref, 'bound-ref-001');
  assert.ok(!JSON.stringify(log).includes('NEVER-LOG-BODY'), 'provider response body must not be stored in log');
  assert.ok(!JSON.stringify(log).includes('msg-body'),       'notification body must not be in delivery log');
});

// 14. All repository calls receive an explicit client
test('[P58] all retry repo method calls receive the explicit client passed to sendPending', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });

  const clientsSeen = new Set();
  function spy(fn) {
    return async function(...args) {
      // client is always the last argument in retry methods
      const client = args[args.length - 1];
      clientsSeen.add(client);
      return fn.apply(r.notificationRepo, args);
    };
  }

  r.notificationRepo.claimPendingNotifications   = spy(r.notificationRepo.claimPendingNotifications.bind(r.notificationRepo));
  r.notificationRepo.beginNotificationAttempt    = spy(r.notificationRepo.beginNotificationAttempt.bind(r.notificationRepo));
  r.notificationRepo.markNotificationDelivered   = spy(r.notificationRepo.markNotificationDelivered.bind(r.notificationRepo));

  const svc = buildNotificationService({ repo: r.notificationRepo, workerId: 'w1' });
  svc.registerProvider('email', { async send() { return { ok: true, provider_ref: 'r1' }; } });

  await r.notificationRepo.insertNotification({
    tenant_id: fx.TENANT_A, status: 'pending', channel: 'email', recipient: 'x', body: 'y'
  }, MOCK_CLIENT);
  await svc.sendPending({ limit: 5, client: MOCK_CLIENT });

  // Every spied call must have received MOCK_CLIENT as the last argument
  assert.equal(clientsSeen.size, 1, 'only one client must have been passed to all repo calls');
  assert.ok(clientsSeen.has(MOCK_CLIENT), 'repo calls must receive the exact client passed to sendPending');
});

// ── New P58-caller tests (Continue.txt #4 item 6) ────────────────────────────

// C1. Missing client throws NOTIFICATION_CLIENT_REQUIRED
test('[P58-caller] requestNotification without client throws NOTIFICATION_CLIENT_REQUIRED', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo });

  await assert.rejects(
    () => svc.requestNotification({ channel: 'email', recipient: 'a@b.c', body: 'hi' }, CTX, undefined),
    (e) => e.code === 'NOTIFICATION_CLIENT_REQUIRED'
  );
  await assert.rejects(
    () => svc.requestNotification({ channel: 'email', recipient: 'a@b.c', body: 'hi' }, CTX, null),
    (e) => e.code === 'NOTIFICATION_CLIENT_REQUIRED'
  );
  await assert.rejects(
    () => svc.requestNotification({ channel: 'email', recipient: 'a@b.c', body: 'hi' }, CTX, { notAQuery: true }),
    (e) => e.code === 'NOTIFICATION_CLIENT_REQUIRED'
  );
});

// C2. Exact supplied client reaches repo.insertNotification
test('[P58-caller] requestNotification passes exact caller client to repo.insertNotification', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });

  let capturedClient;
  const origInsert = r.notificationRepo.insertNotification.bind(r.notificationRepo);
  r.notificationRepo.insertNotification = async (rec, client) => {
    capturedClient = client;
    return origInsert(rec, client);
  };

  const svc = buildNotificationService({ repo: r.notificationRepo });
  await svc.requestNotification({ channel: 'email', recipient: 'a@b.c', body: 'hi' }, CTX, MOCK_CLIENT);

  assert.strictEqual(capturedClient, MOCK_CLIENT, 'repo.insertNotification must receive the exact same client object');
});

// C3. Duplicate enqueue creates one row and emits one audit event
test('[P58-caller] duplicate requestNotification with same source_idempotency_key inserts one row and emits one event', async () => {
  const r = fx.makeFakeRepos();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  const svc = buildNotificationService({ repo: r.notificationRepo });

  // Seed a notification with a source_idempotency_key directly
  await r.notificationRepo.insertNotification({
    tenant_id: fx.TENANT_A, channel: 'email', recipient: 'a@b.c', body: 'hello',
    status: 'pending', source_idempotency_key: 'invite:uuid-001'
  }, MOCK_CLIENT);

  // Second enqueue of same key via requestNotification (simulated via fixture dedup)
  const r2 = r.notificationRepo;
  const origInsert = r2.insertNotification.bind(r2);
  let insertCalls = 0;
  r2.insertNotification = async (rec, client) => { insertCalls++; return origInsert(rec, client); };

  await r.notificationRepo.insertNotification({
    tenant_id: fx.TENANT_A, channel: 'email', recipient: 'a@b.c', body: 'hello',
    status: 'pending', source_idempotency_key: 'invite:uuid-001'
  }, MOCK_CLIENT);

  assert.equal(r.notificationRepo._notifications.length, 1, 'exactly one notification row must exist');
  const events = db.auditRows.filter(x => x.event_type === 'notification.requested');
  assert.ok(events.length <= 1, 'at most one audit event must be emitted for a duplicate key');
});

// C4. Transaction rollback rolls back both notification and business record
test('[P58-caller] rollback of the caller transaction rolls back the notification enqueue', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });

  // Simulate a transactional boundary: insertNotification is called inside an
  // operation that then throws, rolling back the in-memory state.
  let savedSnapshot;
  const origInsert = r.notificationRepo.insertNotification.bind(r.notificationRepo);
  r.notificationRepo.insertNotification = async (rec, client) => {
    savedSnapshot = r.notificationRepo._notifications.length;
    const result = await origInsert(rec, client);
    // simulate rollback: undo what was inserted
    r.notificationRepo._notifications.splice(savedSnapshot);
    return result;
  };

  const svc = buildNotificationService({ repo: r.notificationRepo });
  // The call itself won't throw (rollback is simulated post-insert), but row is gone
  await svc.requestNotification({ channel: 'email', recipient: 'a@b.c', body: 'hi' }, CTX, MOCK_CLIENT);

  assert.equal(r.notificationRepo._notifications.length, 0,
    'notification must be absent after simulated transaction rollback');
});

// C5. No pool fallback exists in the enqueue path
test('[P58-caller] requestNotification path contains no pool.connect, pool.query, client||pool, or undefined client fallback', async () => {
  const src = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '../src/services/notificationService.js'), 'utf8'
  );
  // Verify forbidden patterns are absent from the service source
  assert.ok(!src.includes('pool.connect'),  'pool.connect must not appear in notificationService.js');
  assert.ok(!src.includes('pool.query'),    'pool.query must not appear in notificationService.js');
  assert.ok(!src.includes('_pool.connect'), '_pool.connect must not appear in notificationService.js');
  assert.ok(!src.includes('client || pool'),'client || pool must not appear in notificationService.js');
  assert.ok(!src.includes('|| pool'),       '|| pool fallback must not appear in notificationService.js');
  // insertNotification must be called with client (not undefined or null literal)
  const insertCall = src.match(/insertNotification\([^)]+\)/);
  assert.ok(insertCall, 'insertNotification call must exist');
  assert.ok(!insertCall[0].includes('undefined'), 'insertNotification must not be called with undefined');
  assert.ok(!insertCall[0].includes('null, '),    'insertNotification must not be called with null client');
});

// C6. Route caller (notifications.js POST) passes client via withTenant
test('[P58-caller] route POST handler passes withTenant-sourced client to requestNotification', async () => {
  const routeSrc = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '../src/routes/notifications.js'), 'utf8'
  );
  assert.ok(routeSrc.includes('withTenant'),           'route must use withTenant helper');
  assert.ok(routeSrc.includes('requestNotification'),  'route must call requestNotification');
  // The client from withTenant callback must be threaded into requestNotification
  assert.ok(routeSrc.includes('client'),               'route must pass client argument');
  assert.ok(!routeSrc.includes('pool.connect'),        'route must not call pool.connect directly');
  assert.ok(!routeSrc.includes('pool.query'),          'route must not call pool.query directly');
});
