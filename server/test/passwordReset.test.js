'use strict';

/**
 * Phase 57 / 58 — Password reset service unit tests.
 *
 * Uses in-memory stubs from _fixtures.js. No real DB required.
 * requestReset is enumeration-safe (always returns { ok: true }).
 */

// Must be set before any require that transitively loads config/env.js
process.env.QYRVIA_NOTIFICATION_ENCRYPTION_KEY =
  Buffer.alloc(32, 0x55).toString('base64');
process.env.APP_BASE_URL = 'http://localhost:3001';

const fx       = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const crypto   = require('node:crypto');

const identity                      = require('../src/services/identity');
const { buildPasswordResetService } = require('../src/services/passwordReset');
const { buildIdentityNotificationOutbox } = require('../src/services/identityNotificationOutbox');

// Minimal mock transaction helper that satisfies withTenantFn contract.
// Executes the callback with a fake client that records itself for assertions.
function makeMockWithTenant() {
  let _lastClient = null;
  async function withTenantFn(_tenantId, cb) {
    _lastClient = { _id: 'mock-client', query: async () => ({ rows: [] }) };
    return cb(_lastClient);
  }
  withTenantFn.getLastClient = () => _lastClient;
  return withTenantFn;
}

// Builds a token-capturing outbox backed by the fixture notificationRepo.
function makeOutbox(notificationRepo) {
  let _capturedRawToken = null;
  const outbox = buildIdentityNotificationOutbox({ notificationRepo });
  const capturingOutbox = {
    enqueuePasswordResetNotification: async (data, client) => {
      _capturedRawToken = data.rawToken;
      return outbox.enqueuePasswordResetNotification(data, client);
    }
  };
  capturingOutbox.getCapturedToken = () => _capturedRawToken;
  return capturingOutbox;
}

async function makeServiceWithUser({ status = 'ACTIVE' } = {}) {
  const repos        = fx.makeFakeRepos();
  const passwordHash = await identity.hashPassword('OldPass1!');
  repos.identityRepo._seedUser(
    {
      id: fx.USER_ID, tenant_id: fx.TENANT_A, tenant_code: 'TENANT-A',
      username: 'bob', email: 'bob@example.com',
      password_hash: passwordHash, status
    },
    [], []
  );

  const withTenantFn  = makeMockWithTenant();
  const capturingOutbox = makeOutbox(repos.notificationRepo);
  const svc = buildPasswordResetService({
    repo: repos.passwordResetRepo,
    identityNotificationOutbox: capturingOutbox,
    withTenantFn
  });
  return { svc, repos, withTenantFn, outbox: capturingOutbox };
}

// ── requestReset ──────────────────────────────────────────────────────────────

test('requestReset: found active user returns exactly { ok: true }', async () => {
  const { svc } = await makeServiceWithUser();
  const result = await svc.requestReset({ email: 'bob@example.com' });
  assert.deepEqual(result, { ok: true });
});

test('requestReset: result contains no rawToken, queued, userId, email, or expiresAt', async () => {
  const { svc } = await makeServiceWithUser();
  const result = await svc.requestReset({ email: 'bob@example.com' });
  assert.equal(result.rawToken,    undefined);
  assert.equal(result.queued,      undefined);
  assert.equal(result.userId,      undefined);
  assert.equal(result.email,       undefined);
  assert.equal(result.expiresAt,   undefined);
});

test('requestReset: unknown email returns exactly { ok: true }', async () => {
  const { svc } = await makeServiceWithUser();
  const result = await svc.requestReset({ email: 'ghost@example.com' });
  assert.deepEqual(result, { ok: true });
});

test('requestReset: invalid email format returns exactly { ok: true }', async () => {
  const { svc } = await makeServiceWithUser();
  const result = await svc.requestReset({ email: 'not-an-email' });
  assert.deepEqual(result, { ok: true });
});

test('requestReset: empty email returns exactly { ok: true }', async () => {
  const { svc } = await makeServiceWithUser();
  const result = await svc.requestReset({ email: '' });
  assert.deepEqual(result, { ok: true });
});

test('requestReset: DISABLED user returns exactly { ok: true }', async () => {
  const { svc } = await makeServiceWithUser({ status: 'DISABLED' });
  const result = await svc.requestReset({ email: 'bob@example.com' });
  assert.deepEqual(result, { ok: true });
});

test('requestReset: TERMINATED user returns exactly { ok: true }', async () => {
  const { svc } = await makeServiceWithUser({ status: 'TERMINATED' });
  const result = await svc.requestReset({ email: 'bob@example.com' });
  assert.deepEqual(result, { ok: true });
});

test('requestReset: case-insensitive email lookup', async () => {
  const { svc } = await makeServiceWithUser();
  const result = await svc.requestReset({ email: 'BOB@EXAMPLE.COM' });
  assert.deepEqual(result, { ok: true });
});

test('requestReset: previous pending token is revoked before new one issued', async () => {
  const { svc, repos } = await makeServiceWithUser();
  await svc.requestReset({ email: 'bob@example.com' });
  await svc.requestReset({ email: 'bob@example.com' });

  const tokens = Array.from(repos.passwordResetRepo._resetTokens.values());
  assert.equal(tokens.length, 2);
  // First token inserted (rst_1) must be revoked; second (rst_2) must be pending.
  assert.equal(tokens[0].status, 'revoked');
  assert.equal(tokens[1].status, 'pending');
});

// ── completeReset ─────────────────────────────────────────────────────────────

// Helper: request a reset and capture the raw token via the outbox.
async function requestAndCaptureToken(svc, outbox) {
  await svc.requestReset({ email: 'bob@example.com' });
  return outbox.getCapturedToken();
}

test('completeReset: valid token resets password and marks token used', async () => {
  const { svc, repos, outbox } = await makeServiceWithUser();
  const rawToken = await requestAndCaptureToken(svc, outbox);
  assert.ok(rawToken, 'rawToken must be captured from outbox');

  const result = await svc.completeReset({ token: rawToken, newPassword: 'NewPass1!XY' });
  assert.equal(result.ok, true);

  const tok = Array.from(repos.passwordResetRepo._resetTokens.values())[0];
  assert.equal(tok.status, 'used');

  const user = repos.identityRepo._users.get(fx.USER_ID);
  assert.ok(user.password_hash !== (await identity.hashPassword('OldPass1!')), 'password must change');
});

test('completeReset: missing token returns missing_fields', async () => {
  const { svc } = await makeServiceWithUser();
  const result = await svc.completeReset({ token: null, newPassword: 'NewPass1!' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_fields');
});

test('completeReset: missing newPassword returns missing_fields', async () => {
  const { svc } = await makeServiceWithUser();
  const result = await svc.completeReset({ token: 'sometoken', newPassword: null });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_fields');
});

test('completeReset: password too short returns password_too_short', async () => {
  const { svc, outbox } = await makeServiceWithUser();
  const rawToken = await requestAndCaptureToken(svc, outbox);
  const result = await svc.completeReset({ token: rawToken, newPassword: 'short' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'password_too_short');
});

test('completeReset: invalid token returns reset_token_invalid', async () => {
  const { svc } = await makeServiceWithUser();
  const result = await svc.completeReset({ token: 'a'.repeat(64), newPassword: 'NewPass1!' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'reset_token_invalid');
});

test('completeReset: already-used token returns reset_token_used', async () => {
  const { svc, outbox } = await makeServiceWithUser();
  const rawToken = await requestAndCaptureToken(svc, outbox);
  await svc.completeReset({ token: rawToken, newPassword: 'NewPass1!' });
  const again = await svc.completeReset({ token: rawToken, newPassword: 'AnotherPass1!' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'reset_token_used');
});

test('completeReset: expired token returns reset_token_expired', async () => {
  const { svc, repos, outbox } = await makeServiceWithUser();
  const rawToken = await requestAndCaptureToken(svc, outbox);

  for (const t of repos.passwordResetRepo._resetTokens.values()) {
    t.expires_at = new Date(Date.now() - 1000).toISOString();
  }

  const result = await svc.completeReset({ token: rawToken, newPassword: 'NewPass1!' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'reset_token_expired');
});

test('completeReset: successful reset revokes all refresh tokens for user', async () => {
  const { svc, repos, outbox } = await makeServiceWithUser();
  const rt = await repos.tokensRepo.insertRefreshToken({
    user_id: fx.USER_ID, tenant_id: fx.TENANT_A,
    token_hash: 'rt-hash-1', family: 'fam1', revoked_at: null
  });
  const rawToken = await requestAndCaptureToken(svc, outbox);
  await svc.completeReset({ token: rawToken, newPassword: 'NewPass1!' });

  const storedRt = repos.tokensRepo._refreshTokens.get(rt.token_hash);
  assert.ok(storedRt.revoked_at, 'refresh token must be revoked after password reset');
});
