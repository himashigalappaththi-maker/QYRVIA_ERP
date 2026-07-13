'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fx = require('./_fixtures');

// Satisfies _requireClient guard without a real DB connection.
const MOCK_CLIENT = Object.freeze({ _isMockTenantClient: true });

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';

function makeRepo() {
  return fx.makeFakeRepos().notificationRepo;
}

async function seedNotif(repo, overrides = {}) {
  const { row } = await repo.insertNotification(Object.assign({
    tenant_id:      TENANT_A,
    status:         'pending',
    channel:        'email',
    template_code:  'test',
    recipient_ref:  'user-1'
  }, overrides), MOCK_CLIENT);
  return row;
}

// ── 1. Two workers cannot claim the same row ──────────────────────────────────

test('two workers cannot claim the same pending row', async () => {
  const repo = makeRepo();
  await seedNotif(repo);

  const claimedA = await repo.claimPendingNotifications({ workerId: 'worker-A', limit: 1 }, MOCK_CLIENT);
  assert.equal(claimedA.length, 1, 'worker A must claim the row');
  assert.equal(claimedA[0].locked_by, 'worker-A');

  const claimedB = await repo.claimPendingNotifications({ workerId: 'worker-B', limit: 1 }, MOCK_CLIENT);
  assert.equal(claimedB.length, 0, 'worker B must not claim an already-claimed row');
});

// ── 2. Bounded batch size ─────────────────────────────────────────────────────

test('claimPendingNotifications respects the limit parameter', async () => {
  const repo = makeRepo();
  for (let i = 0; i < 5; i++) await seedNotif(repo);

  const claimed = await repo.claimPendingNotifications({ workerId: 'worker-A', limit: 3 }, MOCK_CLIENT);
  assert.equal(claimed.length, 3, 'must claim exactly the requested limit');
  assert.ok(repo._notifications.filter(n => n.status === 'sending').length === 3);
  assert.ok(repo._notifications.filter(n => n.status === 'pending').length === 2);
});

// ── 3. Future next_attempt_at rows are skipped ────────────────────────────────

test('pending row with future next_attempt_at is skipped by claim', async () => {
  const repo = makeRepo();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await seedNotif(repo, { next_attempt_at: future });

  const claimed = await repo.claimPendingNotifications({ workerId: 'worker-A' }, MOCK_CLIENT);
  assert.equal(claimed.length, 0, 'future-scheduled row must not be claimed yet');
});

// ── 4. Stale sending rows are reclaimable ────────────────────────────────────

test('stale sending row (lease expired) is reclaimable by a new worker', async () => {
  const repo = makeRepo();
  const staleLockedAt = new Date(Date.now() - 70 * 60 * 1000).toISOString(); // 70 min ago
  const n = await seedNotif(repo, { status: 'sending', locked_by: 'dead-worker', locked_at: staleLockedAt });

  const claimed = await repo.claimPendingNotifications({ workerId: 'worker-B', leaseMinutes: 10 }, MOCK_CLIENT);
  assert.equal(claimed.length, 1, 'stale row must be reclaimable');
  assert.equal(claimed[0].id, n.id);
  assert.equal(claimed[0].locked_by, 'worker-B');
});

// ── 5. Fresh sending rows are not reclaimable ─────────────────────────────────

test('fresh sending row (lease not expired) is not reclaimable', async () => {
  const repo = makeRepo();
  const freshLockedAt = new Date(Date.now() - 30 * 1000).toISOString(); // 30 sec ago
  await seedNotif(repo, { status: 'sending', locked_by: 'active-worker', locked_at: freshLockedAt });

  const claimed = await repo.claimPendingNotifications({ workerId: 'worker-B', leaseMinutes: 10 }, MOCK_CLIENT);
  assert.equal(claimed.length, 0, 'fresh lease must not be reclaimed');
});

// ── 6. Stale reclaim does not increment attempt_count ────────────────────────

test('reclaiming a stale row does not increment attempt_count', async () => {
  const repo = makeRepo();
  const staleLockedAt = new Date(Date.now() - 70 * 60 * 1000).toISOString();
  const n = await seedNotif(repo, {
    status: 'sending', locked_by: 'dead-worker', locked_at: staleLockedAt, attempt_count: 1
  });
  assert.equal(n.attempt_count, 1);

  const claimed = await repo.claimPendingNotifications({ workerId: 'worker-B', leaseMinutes: 10 }, MOCK_CLIENT);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].attempt_count, 1, 'attempt_count must not change on reclaim');
});

// ── 7. Provider send increments attempt_count exactly once ───────────────────

test('beginNotificationAttempt increments attempt_count by exactly 1 and guards against alternate-key replay', async () => {
  const repo = makeRepo();
  await seedNotif(repo);
  const [claimed] = await repo.claimPendingNotifications({ workerId: 'worker-A' }, MOCK_CLIENT);
  assert.equal(claimed.attempt_count, 0);

  const r = await repo.beginNotificationAttempt(claimed.id, 'worker-A', 'idem-key-1', MOCK_CLIENT);
  assert.ok(r, 'must return updated row');
  assert.equal(r.attempt_count, 1, 'must be 1 after first begin');
  assert.equal(r.provider_idempotency_key, 'idem-key-1');

  // A different idempotency key must be blocked (prevents stale worker from double-incrementing)
  const blocked = await repo.beginNotificationAttempt(claimed.id, 'worker-A', 'OTHER-KEY', MOCK_CLIENT);
  assert.equal(blocked, null, 'different idempotency key must be rejected');

  const stored = repo._notifications.find(x => x.id === claimed.id);
  assert.equal(stored.attempt_count, 1, 'attempt_count must remain 1 after blocked call');
});

// ── 8. Retry backoff returns row to pending ───────────────────────────────────

test('markNotificationRetry returns row to pending with scheduled next_attempt_at and clears locks', async () => {
  const repo = makeRepo();
  await seedNotif(repo);
  const [claimed] = await repo.claimPendingNotifications({ workerId: 'worker-A' }, MOCK_CLIENT);
  const begun    = await repo.beginNotificationAttempt(claimed.id, 'worker-A', 'idem-1', MOCK_CLIENT);

  const nextAt  = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const retried = await repo.markNotificationRetry(claimed.id, 'worker-A', begun.attempt_count, nextAt, MOCK_CLIENT);

  assert.ok(retried, 'must return row');
  assert.equal(retried.status,          'pending');
  assert.equal(retried.next_attempt_at, nextAt);
  assert.equal(retried.locked_by,       null);
  assert.equal(retried.locked_at,       null);
  assert.equal(retried.completed_at,    null);
  assert.equal(retried.attempt_count,   1, 'attempt_count must not change on retry');
});

// ── 9. Terminal failure after max attempts ────────────────────────────────────

test('markNotificationFailed succeeds when attempt_count reaches max_attempts', async () => {
  const repo = makeRepo();
  await seedNotif(repo, { max_attempts: 1 });
  const [claimed] = await repo.claimPendingNotifications({ workerId: 'worker-A' }, MOCK_CLIENT);
  await repo.beginNotificationAttempt(claimed.id, 'worker-A', 'idem-1', MOCK_CLIENT);
  // attempt_count is now 1 == max_attempts (1)

  const failed = await repo.markNotificationFailed(claimed.id, 'worker-A', 1, 'exhausted', MOCK_CLIENT);
  assert.ok(failed, 'must return row on terminal failure');
  assert.equal(failed.status,      'failed');
  assert.equal(failed.locked_by,   null);
  assert.equal(failed.locked_at,   null);
  assert.ok(failed.completed_at,   'completed_at must be set');
});

test('markNotificationFailed with permanent class succeeds even below max_attempts', async () => {
  const repo = makeRepo();
  await seedNotif(repo, { max_attempts: 3 });
  const [claimed] = await repo.claimPendingNotifications({ workerId: 'worker-A' }, MOCK_CLIENT);
  await repo.beginNotificationAttempt(claimed.id, 'worker-A', 'idem-1', MOCK_CLIENT);
  // attempt_count=1, max_attempts=3 — not exhausted yet

  const failed = await repo.markNotificationFailed(claimed.id, 'worker-A', 1, 'permanent', MOCK_CLIENT);
  assert.ok(failed, 'permanent failureClass must override ceiling guard');
  assert.equal(failed.status, 'failed');
});

// ── 10. Success clears locks and records delivery ─────────────────────────────

test('markNotificationDelivered clears locks, sets completed_at, and records provider message', async () => {
  const repo = makeRepo();
  await seedNotif(repo);
  const [claimed]   = await repo.claimPendingNotifications({ workerId: 'worker-A' }, MOCK_CLIENT);
  const begun       = await repo.beginNotificationAttempt(claimed.id, 'worker-A', 'idem-1', MOCK_CLIENT);

  const delivered = await repo.markNotificationDelivered(claimed.id, 'worker-A', begun.attempt_count, 'provider-msg-001', MOCK_CLIENT);
  assert.ok(delivered, 'must return row');
  assert.equal(delivered.status,              'delivered');
  assert.equal(delivered.locked_by,           null);
  assert.equal(delivered.locked_at,           null);
  assert.equal(delivered.next_attempt_at,     null);
  assert.ok(delivered.completed_at,           'completed_at must be set');
  assert.equal(delivered.provider_message_id, 'provider-msg-001');
});

// ── 11. Ownership guard models tenant RLS + locked_by isolation ───────────────

test('delivery by wrong worker returns null (ownership guard prevents cross-worker mutation)', async () => {
  const repo = makeRepo();
  await seedNotif(repo);
  const [claimed] = await repo.claimPendingNotifications({ workerId: 'worker-A' }, MOCK_CLIENT);
  await repo.beginNotificationAttempt(claimed.id, 'worker-A', 'idem-1', MOCK_CLIENT);

  const result = await repo.markNotificationDelivered(claimed.id, 'worker-B', 1, 'spoofed', MOCK_CLIENT);
  assert.equal(result, null, 'wrong worker must not deliver another worker\'s row');

  const stored = repo._notifications.find(x => x.id === claimed.id);
  assert.equal(stored.status, 'sending', 'row must remain in sending state');
  assert.equal(stored.locked_by, 'worker-A', 'original ownership must be preserved');
});

// ── 12. Provider idempotency key is preserved on conflict ─────────────────────

test('provider idempotency key is not overwritten when a second different key is presented', async () => {
  const repo = makeRepo();
  await seedNotif(repo, { max_attempts: 3 });
  const [claimed] = await repo.claimPendingNotifications({ workerId: 'worker-A' }, MOCK_CLIENT);

  await repo.beginNotificationAttempt(claimed.id, 'worker-A', 'stable-key', MOCK_CLIENT);

  const replay = await repo.beginNotificationAttempt(claimed.id, 'worker-A', 'different-key', MOCK_CLIENT);
  assert.equal(replay, null, 'conflicting idempotency key must be rejected');

  const stored = repo._notifications.find(x => x.id === claimed.id);
  assert.equal(stored.provider_idempotency_key, 'stable-key', 'original key must be preserved');
  assert.equal(stored.attempt_count, 1, 'attempt_count must not double-increment');
});

// ── 13. Missing client throws NOTIFICATION_CLIENT_REQUIRED ───────────────────

test('any retry method without client throws NOTIFICATION_CLIENT_REQUIRED', async () => {
  const repo = makeRepo();

  await assert.rejects(
    () => repo.claimPendingNotifications({ workerId: 'w' }, undefined),
    (e) => e.code === 'NOTIFICATION_CLIENT_REQUIRED'
  );
  await assert.rejects(
    () => repo.beginNotificationAttempt('notif_1', 'w', 'k', undefined),
    (e) => e.code === 'NOTIFICATION_CLIENT_REQUIRED'
  );
  await assert.rejects(
    () => repo.markNotificationDelivered('notif_1', 'w', 1, 'mid', undefined),
    (e) => e.code === 'NOTIFICATION_CLIENT_REQUIRED'
  );
  await assert.rejects(
    () => repo.markNotificationRetry('notif_1', 'w', 1, new Date().toISOString(), undefined),
    (e) => e.code === 'NOTIFICATION_CLIENT_REQUIRED'
  );
  await assert.rejects(
    () => repo.markNotificationFailed('notif_1', 'w', 1, 'permanent', undefined),
    (e) => e.code === 'NOTIFICATION_CLIENT_REQUIRED'
  );
});

// ── 14. No PII or token appears in error messages ────────────────────────────

test('NOTIFICATION_CLIENT_REQUIRED error message contains no PII, tokens, or payload data', () => {
  const repo = makeRepo();
  try {
    repo._requireClient(undefined);
    assert.fail('expected throw');
  } catch (e) {
    assert.equal(e.code, 'NOTIFICATION_CLIENT_REQUIRED');
    // Must be a fixed internal string — no recipient, email, token, or payload leakage
    assert.ok(!e.message.includes('tenant_id'),  'must not expose tenant_id');
    assert.ok(!e.message.includes('token'),       'must not expose token');
    assert.ok(!e.message.includes('email'),       'must not expose email');
    assert.ok(!e.message.includes('password'),    'must not expose password');
    assert.ok(!e.message.includes('recipient'),   'must not expose recipient');
    assert.ok(e.message.length < 200,             'error message must be bounded');
  }
});
