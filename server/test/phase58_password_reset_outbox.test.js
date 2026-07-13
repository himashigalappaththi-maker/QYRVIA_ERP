'use strict';

/**
 * Phase 58 — Password-reset encrypted-outbox integration tests.
 *
 * Proves atomicity, client threading, encrypted payload boundary,
 * rollback behavior, and enumeration resistance — all without a real DB.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const crypto   = require('node:crypto');

process.env.QYRVIA_NOTIFICATION_ENCRYPTION_KEY =
  Buffer.alloc(32, 0x42).toString('base64');
process.env.APP_BASE_URL = 'http://localhost:3001';

const fx = require('./_fixtures');
const { buildPasswordResetService }        = require('../src/services/passwordReset');
const { buildIdentityNotificationOutbox }  = require('../src/services/identityNotificationOutbox');
const { decryptNotificationPayload }       = require('../src/security/notificationPayloadCrypto');
const identity = require('../src/services/identity');

// ── Test harness ──────────────────────────────────────────────────────────────

/**
 * Minimal transaction harness.
 * Exposes a snapshot/restore mechanism so rollback tests can verify that
 * state written inside a failed callback is undone in the fake store.
 */
function makeTransactionHarness(passwordResetRepo, notificationRepo) {
  let _lastClient = null;

  async function withTenantFn(tenantId, cb) {
    // Deep-copy token objects so in-place mutations (status changes) are reversible.
    const resetSnapshot  = new Map(
      Array.from(passwordResetRepo._resetTokens.entries())
        .map(([k, v]) => [k, Object.assign({}, v)])
    );
    const notifSnapshot  = notificationRepo._notifications.slice();

    _lastClient = {
      tenantId,
      _id:   'tx-client-' + Math.random().toString(36).slice(2),
      query: async () => ({ rows: [] })
    };

    try {
      const result = await cb(_lastClient);
      // Success — leave state as-is (commit).
      return result;
    } catch (err) {
      // Rollback: restore snapshots.
      passwordResetRepo._resetTokens.clear();
      for (const [k, v] of resetSnapshot) passwordResetRepo._resetTokens.set(k, v);
      notificationRepo._notifications.length = 0;
      for (const n of notifSnapshot) notificationRepo._notifications.push(n);
      throw err;
    }
  }

  withTenantFn.getLastClient = () => _lastClient;
  return withTenantFn;
}

async function makeSetup({ userStatus = 'ACTIVE' } = {}) {
  const repos = fx.makeFakeRepos();
  const passwordHash = await identity.hashPassword('OldPass1!');
  repos.identityRepo._seedUser(
    {
      id: fx.USER_ID, tenant_id: fx.TENANT_A, tenant_code: 'TENANT-A',
      username: 'bob', email: 'bob@example.com',
      password_hash: passwordHash, status: userStatus
    },
    [], []
  );

  const withTenantFn = makeTransactionHarness(
    repos.passwordResetRepo,
    repos.notificationRepo
  );

  const identityNotificationOutbox = buildIdentityNotificationOutbox({
    notificationRepo: repos.notificationRepo
  });

  const svc = buildPasswordResetService({
    repo: repos.passwordResetRepo,
    identityNotificationOutbox,
    withTenantFn
  });

  return { svc, repos, withTenantFn, identityNotificationOutbox };
}

// ── Public response and enumeration resistance ────────────────────────────────

test('known identity: requestReset returns exactly { ok: true }', async () => {
  const { svc } = await makeSetup();
  const result = await svc.requestReset({ email: 'bob@example.com' });
  assert.deepEqual(result, { ok: true });
});

test('unknown identity: requestReset returns exactly { ok: true }', async () => {
  const { svc } = await makeSetup();
  const result = await svc.requestReset({ email: 'nobody@example.com' });
  assert.deepEqual(result, { ok: true });
});

test('result contains no rawToken, queued, userId, email, tenantId, resetRecordId, or notificationId', async () => {
  const { svc } = await makeSetup();
  const result = await svc.requestReset({ email: 'bob@example.com' });
  const forbidden = ['rawToken','queued','userId','email','tenantId','resetRecordId','notificationId','found','exists'];
  for (const k of forbidden) assert.equal(result[k], undefined, `result must not contain ${k}`);
});

test('unknown identity: no revocation, no token insertion, no notification', async () => {
  const { svc, repos } = await makeSetup();
  await svc.requestReset({ email: 'nobody@example.com' });
  assert.equal(repos.passwordResetRepo._resetTokens.size, 0);
  assert.equal(repos.notificationRepo._notifications.length, 0);
  assert.equal(repos.passwordResetRepo._lastRevokeClient, undefined);
  assert.equal(repos.passwordResetRepo._lastInsertClient, undefined);
});

// ── Exact client threading ────────────────────────────────────────────────────

test('revokeActivePasswordResetTokensForUser receives the transaction client', async () => {
  const { svc, repos, withTenantFn } = await makeSetup();
  await svc.requestReset({ email: 'bob@example.com' });
  const txClient = withTenantFn.getLastClient();
  assert.ok(txClient, 'transaction client must exist');
  assert.strictEqual(repos.passwordResetRepo._lastRevokeClient, txClient);
});

test('insertPasswordResetToken receives the exact same transaction client', async () => {
  const { svc, repos, withTenantFn } = await makeSetup();
  await svc.requestReset({ email: 'bob@example.com' });
  const txClient = withTenantFn.getLastClient();
  assert.strictEqual(repos.passwordResetRepo._lastInsertClient, txClient);
});

test('notificationRepo.insertNotification receives the exact same transaction client', async () => {
  const repos = fx.makeFakeRepos();
  const passwordHash = await identity.hashPassword('OldPass1!');
  repos.identityRepo._seedUser(
    { id: fx.USER_ID, tenant_id: fx.TENANT_A, tenant_code: 'TENANT-A',
      username: 'bob', email: 'bob@example.com', password_hash: passwordHash, status: 'ACTIVE' },
    [], []
  );

  let capturedNotifClient = null;
  const trackedNotifRepo = Object.assign({}, repos.notificationRepo, {
    insertNotification: async (rec, client) => {
      capturedNotifClient = client;
      return repos.notificationRepo.insertNotification(rec, client);
    }
  });

  const outbox = buildIdentityNotificationOutbox({ notificationRepo: trackedNotifRepo });
  const withTenantFn = makeTransactionHarness(repos.passwordResetRepo, repos.notificationRepo);

  const svc = buildPasswordResetService({
    repo: repos.passwordResetRepo,
    identityNotificationOutbox: outbox,
    withTenantFn
  });

  await svc.requestReset({ email: 'bob@example.com' });
  const txClient = withTenantFn.getLastClient();

  assert.strictEqual(repos.passwordResetRepo._lastRevokeClient, txClient);
  assert.strictEqual(repos.passwordResetRepo._lastInsertClient, txClient);
  assert.strictEqual(capturedNotifClient, txClient);
});

// ── Atomic transaction behavior ───────────────────────────────────────────────

test('success: creates exactly one reset token and one notification', async () => {
  const { svc, repos } = await makeSetup();
  await svc.requestReset({ email: 'bob@example.com' });
  assert.equal(repos.passwordResetRepo._resetTokens.size, 1);
  assert.equal(repos.notificationRepo._notifications.length, 1);
});

test('success: revoke + insert + notify committed together', async () => {
  const { svc, repos } = await makeSetup();
  // Seed a prior pending token directly.
  repos.passwordResetRepo._resetTokens.set('rst_prior', {
    id: 'rst_prior', user_id: fx.USER_ID, tenant_id: fx.TENANT_A,
    token_hash: 'old-hash', status: 'pending',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    created_at: new Date().toISOString()
  });

  await svc.requestReset({ email: 'bob@example.com' });

  const tokens = Array.from(repos.passwordResetRepo._resetTokens.values());
  assert.equal(tokens.length, 2);
  const prior = tokens.find(t => t.id === 'rst_prior');
  const newer = tokens.find(t => t.id !== 'rst_prior');
  assert.equal(prior.status, 'revoked');
  assert.equal(newer.status, 'pending');
  assert.equal(repos.notificationRepo._notifications.length, 1);
});

test('revocation failure: no token inserted, no notification created', async () => {
  const repos = fx.makeFakeRepos();
  const passwordHash = await identity.hashPassword('OldPass1!');
  repos.identityRepo._seedUser(
    { id: fx.USER_ID, tenant_id: fx.TENANT_A, username: 'bob',
      email: 'bob@example.com', password_hash: passwordHash, status: 'ACTIVE' },
    [], []
  );

  // Override revocation to throw inside the transaction.
  const failingRepo = Object.assign({}, repos.passwordResetRepo, {
    revokeActivePasswordResetTokensForUser: async (_userId, client) => {
      if (!client || typeof client.query !== 'function') throw Object.assign(new Error('no client'), { code: 'PASSWORD_RESET_CLIENT_REQUIRED' });
      throw new Error('revocation DB error');
    }
  });

  const outbox = buildIdentityNotificationOutbox({ notificationRepo: repos.notificationRepo });
  const withTenantFn = makeTransactionHarness(repos.passwordResetRepo, repos.notificationRepo);

  const svc = buildPasswordResetService({
    repo: failingRepo,
    identityNotificationOutbox: outbox,
    withTenantFn
  });

  await assert.rejects(() => svc.requestReset({ email: 'bob@example.com' }), /revocation DB error/);
  assert.equal(repos.passwordResetRepo._resetTokens.size, 0, 'no token must remain after revocation failure');
  assert.equal(repos.notificationRepo._notifications.length, 0, 'no notification must remain after revocation failure');
});

test('token insertion failure: rolls back revocation', async () => {
  const repos = fx.makeFakeRepos();
  const passwordHash = await identity.hashPassword('OldPass1!');
  repos.identityRepo._seedUser(
    { id: fx.USER_ID, tenant_id: fx.TENANT_A, username: 'bob',
      email: 'bob@example.com', password_hash: passwordHash, status: 'ACTIVE' },
    [], []
  );

  // Seed a prior pending token.
  repos.passwordResetRepo._resetTokens.set('rst_prior', {
    id: 'rst_prior', user_id: fx.USER_ID, status: 'pending',
    token_hash: 'old-hash', expires_at: new Date(Date.now() + 3600000).toISOString(),
    created_at: new Date().toISOString()
  });

  const failingRepo = Object.assign({}, repos.passwordResetRepo, {
    insertPasswordResetToken: async (_rec, client) => {
      if (!client || typeof client.query !== 'function') throw Object.assign(new Error('no client'), { code: 'PASSWORD_RESET_CLIENT_REQUIRED' });
      throw new Error('insert DB error');
    }
  });

  const outbox = buildIdentityNotificationOutbox({ notificationRepo: repos.notificationRepo });
  const withTenantFn = makeTransactionHarness(repos.passwordResetRepo, repos.notificationRepo);

  const svc = buildPasswordResetService({
    repo: failingRepo,
    identityNotificationOutbox: outbox,
    withTenantFn
  });

  await assert.rejects(() => svc.requestReset({ email: 'bob@example.com' }), /insert DB error/);

  // After rollback, prior token must still be pending.
  const prior = repos.passwordResetRepo._resetTokens.get('rst_prior');
  assert.equal(prior.status, 'pending', 'prior token must be restored to pending after rollback');
  assert.equal(repos.notificationRepo._notifications.length, 0);
});

test('notification insertion failure: rolls back token insertion and revocation', async () => {
  const repos = fx.makeFakeRepos();
  const passwordHash = await identity.hashPassword('OldPass1!');
  repos.identityRepo._seedUser(
    { id: fx.USER_ID, tenant_id: fx.TENANT_A, username: 'bob',
      email: 'bob@example.com', password_hash: passwordHash, status: 'ACTIVE' },
    [], []
  );

  repos.passwordResetRepo._resetTokens.set('rst_prior', {
    id: 'rst_prior', user_id: fx.USER_ID, status: 'pending',
    token_hash: 'old-hash', expires_at: new Date(Date.now() + 3600000).toISOString(),
    created_at: new Date().toISOString()
  });

  const failingNotifRepo = Object.assign({}, repos.notificationRepo, {
    insertNotification: async (_rec, _client) => {
      throw new Error('notification DB error');
    }
  });

  const outbox = buildIdentityNotificationOutbox({ notificationRepo: failingNotifRepo });
  const withTenantFn = makeTransactionHarness(repos.passwordResetRepo, repos.notificationRepo);

  const svc = buildPasswordResetService({
    repo: repos.passwordResetRepo,
    identityNotificationOutbox: outbox,
    withTenantFn
  });

  await assert.rejects(() => svc.requestReset({ email: 'bob@example.com' }), /notification DB error/);

  // Token insertion rolled back — only the prior token remains.
  assert.equal(repos.passwordResetRepo._resetTokens.size, 1);
  const prior = repos.passwordResetRepo._resetTokens.get('rst_prior');
  assert.equal(prior.status, 'pending', 'prior token must be restored to pending after rollback');
  assert.equal(repos.notificationRepo._notifications.length, 0);
});

test('encryption failure: rolls back revocation and token insertion', async () => {
  const repos = fx.makeFakeRepos();
  const passwordHash = await identity.hashPassword('OldPass1!');
  repos.identityRepo._seedUser(
    { id: fx.USER_ID, tenant_id: fx.TENANT_A, username: 'bob',
      email: 'bob@example.com', password_hash: passwordHash, status: 'ACTIVE' },
    [], []
  );

  repos.passwordResetRepo._resetTokens.set('rst_prior', {
    id: 'rst_prior', user_id: fx.USER_ID, status: 'pending',
    token_hash: 'old-hash', expires_at: new Date(Date.now() + 3600000).toISOString(),
    created_at: new Date().toISOString()
  });

  // Inject an outbox that simulates CRYPTO_KEY_MISSING (config/env is module-cached,
  // so mutating process.env after load has no effect on the cached config object).
  const failingOutbox = {
    enqueuePasswordResetNotification: async (_data, _client) => {
      const err = new Error('Notification encryption key is not configured');
      err.code = 'CRYPTO_KEY_MISSING';
      throw err;
    }
  };

  const withTenantFn = makeTransactionHarness(repos.passwordResetRepo, repos.notificationRepo);

  const svc = buildPasswordResetService({
    repo: repos.passwordResetRepo,
    identityNotificationOutbox: failingOutbox,
    withTenantFn
  });

  await assert.rejects(
    () => svc.requestReset({ email: 'bob@example.com' }),
    (err) => err.code === 'CRYPTO_KEY_MISSING'
  );

  const prior = repos.passwordResetRepo._resetTokens.get('rst_prior');
  assert.equal(prior.status, 'pending', 'prior token must be restored to pending after crypto failure');
  assert.equal(repos.passwordResetRepo._resetTokens.size, 1, 'new token must not persist');
  assert.equal(repos.notificationRepo._notifications.length, 0);
});

// ── Encrypted payload boundary ────────────────────────────────────────────────

test('notification plaintext fields contain no email', async () => {
  const { svc, repos } = await makeSetup();
  await svc.requestReset({ email: 'bob@example.com' });
  const notif = repos.notificationRepo._notifications[0];
  const sensitiveFields = ['subject', 'body', 'recipient', 'context', 'source_idempotency_key'];
  for (const f of sensitiveFields) {
    const v = JSON.stringify(notif[f] ?? '');
    assert.ok(!v.includes('bob@example.com'), `${f} must not contain email`);
  }
});

test('notification plaintext fields contain no raw token', async () => {
  const { svc, repos } = await makeSetup();
  // Capture the raw token via a wrapping outbox.
  let capturedRawToken = null;
  const originalOutbox = buildIdentityNotificationOutbox({ notificationRepo: repos.notificationRepo });
  const wrapping = {
    enqueuePasswordResetNotification: async (data, client) => {
      capturedRawToken = data.rawToken;
      return originalOutbox.enqueuePasswordResetNotification(data, client);
    }
  };
  const withTenantFn = makeTransactionHarness(repos.passwordResetRepo, repos.notificationRepo);
  const svc2 = buildPasswordResetService({
    repo: repos.passwordResetRepo,
    identityNotificationOutbox: wrapping,
    withTenantFn
  });

  await svc2.requestReset({ email: 'bob@example.com' });
  assert.ok(capturedRawToken, 'raw token must be captured');

  const notif = repos.notificationRepo._notifications[0];
  const sensitiveFields = ['subject', 'body', 'recipient', 'context', 'source_idempotency_key'];
  for (const f of sensitiveFields) {
    const v = JSON.stringify(notif[f] ?? '');
    assert.ok(!v.includes(capturedRawToken), `${f} must not contain raw token`);
  }
});

test('decrypting the notification payload recovers type, email, token, resetUrl, and expiresAt', async () => {
  const repos = fx.makeFakeRepos();
  const passwordHash = await identity.hashPassword('OldPass1!');
  repos.identityRepo._seedUser(
    { id: fx.USER_ID, tenant_id: fx.TENANT_A, username: 'bob',
      email: 'bob@example.com', password_hash: passwordHash, status: 'ACTIVE' },
    [], []
  );

  let capturedRawToken = null;
  const outbox = buildIdentityNotificationOutbox({ notificationRepo: repos.notificationRepo });
  const wrapping = {
    enqueuePasswordResetNotification: async (data, client) => {
      capturedRawToken = data.rawToken;
      return outbox.enqueuePasswordResetNotification(data, client);
    }
  };
  const withTenantFn = makeTransactionHarness(repos.passwordResetRepo, repos.notificationRepo);

  const svc = buildPasswordResetService({
    repo: repos.passwordResetRepo,
    identityNotificationOutbox: wrapping,
    withTenantFn
  });

  await svc.requestReset({ email: 'bob@example.com' });
  const notif = repos.notificationRepo._notifications[0];

  const decrypted = decryptNotificationPayload(notif);
  assert.equal(decrypted.type,     'password_reset');
  assert.equal(decrypted.email,    'bob@example.com');
  assert.equal(decrypted.token,    capturedRawToken);
  assert.ok(decrypted.resetUrl,    'resetUrl must be present');
  assert.ok(
    decrypted.resetUrl.includes(encodeURIComponent(capturedRawToken)),
    'resetUrl must contain URL-encoded token'
  );
  assert.ok(decrypted.expiresAt,   'expiresAt must be present');
});

test('source_idempotency_key is password-reset:<resetRecordId> and contains no email or token', async () => {
  const { svc, repos } = await makeSetup();
  await svc.requestReset({ email: 'bob@example.com' });
  const notif = repos.notificationRepo._notifications[0];
  const key = notif.source_idempotency_key;
  assert.ok(key.startsWith('password-reset:'), 'key must start with password-reset:');
  assert.ok(!key.includes('@'), 'key must not contain email');
  assert.ok(key.length < 100, 'key must not contain a long token');
});

test('plaintext recipient is the identityId, not the email address', async () => {
  const { svc, repos } = await makeSetup();
  await svc.requestReset({ email: 'bob@example.com' });
  const notif = repos.notificationRepo._notifications[0];
  assert.equal(notif.recipient, fx.USER_ID);
  assert.ok(!notif.recipient.includes('@'), 'recipient must not be an email address');
});
