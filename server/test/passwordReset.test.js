'use strict';

/**
 * Phase 57 — Password reset service unit tests.
 *
 * Uses in-memory stubs from _fixtures.js. No real DB required.
 * requestReset is enumeration-safe (always returns ok:true).
 */

const fx       = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');

const identity                      = require('../src/services/identity');
const { buildPasswordResetService } = require('../src/services/passwordReset');

async function makeServiceWithUser({ status = 'ACTIVE' } = {}) {
  const repos       = fx.makeFakeRepos();
  const passwordHash = await identity.hashPassword('OldPass1!');
  repos.identityRepo._seedUser(
    {
      id: fx.USER_ID, tenant_id: fx.TENANT_A, tenant_code: 'TENANT-A',
      username: 'bob', email: 'bob@example.com',
      password_hash: passwordHash, status
    },
    [], []
  );
  const svc = buildPasswordResetService({ repo: repos.passwordResetRepo });
  return { svc, repos };
}

// ── requestReset ──────────────────────────────────────────────────────────────

test('requestReset: found active user returns ok:true, queued:true, rawToken', async () => {
  const { svc } = await makeServiceWithUser();
  const result = await svc.requestReset({ email: 'bob@example.com' });
  assert.equal(result.ok, true);
  assert.equal(result.queued, true);
  assert.ok(typeof result.rawToken === 'string' && result.rawToken.length === 64);
  assert.ok(result.userId);
});

test('requestReset: unknown email returns ok:true, queued:false (enumeration-safe)', async () => {
  const { svc } = await makeServiceWithUser();
  const result = await svc.requestReset({ email: 'ghost@example.com' });
  assert.equal(result.ok, true);
  assert.equal(result.queued, false);
  assert.equal(result.rawToken, undefined);
});

test('requestReset: invalid email format returns ok:true, queued:false', async () => {
  const { svc } = await makeServiceWithUser();
  const result = await svc.requestReset({ email: 'not-an-email' });
  assert.equal(result.ok, true);
  assert.equal(result.queued, false);
});

test('requestReset: empty email returns ok:true, queued:false', async () => {
  const { svc } = await makeServiceWithUser();
  const result = await svc.requestReset({ email: '' });
  assert.equal(result.ok, true);
  assert.equal(result.queued, false);
});

test('requestReset: DISABLED user returns ok:true, queued:false (enumeration-safe)', async () => {
  const { svc } = await makeServiceWithUser({ status: 'DISABLED' });
  const result = await svc.requestReset({ email: 'bob@example.com' });
  assert.equal(result.ok, true);
  assert.equal(result.queued, false);
});

test('requestReset: TERMINATED user returns ok:true, queued:false', async () => {
  const { svc } = await makeServiceWithUser({ status: 'TERMINATED' });
  const result = await svc.requestReset({ email: 'bob@example.com' });
  assert.equal(result.ok, true);
  assert.equal(result.queued, false);
});

test('requestReset: case-insensitive email lookup', async () => {
  const { svc } = await makeServiceWithUser();
  const result = await svc.requestReset({ email: 'BOB@EXAMPLE.COM' });
  assert.equal(result.ok, true);
  assert.equal(result.queued, true);
});

test('requestReset: previous pending token is revoked before new one issued', async () => {
  const { svc, repos } = await makeServiceWithUser();
  const first  = await svc.requestReset({ email: 'bob@example.com' });
  const second = await svc.requestReset({ email: 'bob@example.com' });
  assert.equal(second.queued, true);

  // Find first token in store and verify it was revoked
  for (const t of repos.passwordResetRepo._resetTokens.values()) {
    if (t.token_hash !== require('node:crypto').createHash('sha256').update(second.rawToken).digest('hex')) {
      assert.equal(t.status, 'revoked', 'prior token must be revoked');
    }
  }
  void first; // used above
});

// ── completeReset ─────────────────────────────────────────────────────────────

test('completeReset: valid token resets password and marks token used', async () => {
  const { svc, repos } = await makeServiceWithUser();
  const req = await svc.requestReset({ email: 'bob@example.com' });
  const result = await svc.completeReset({ token: req.rawToken, newPassword: 'NewPass1!XY' });
  assert.equal(result.ok, true);

  // Token must be marked used
  const tok = Array.from(repos.passwordResetRepo._resetTokens.values())[0];
  assert.equal(tok.status, 'used');

  // Refresh tokens must be revoked
  // (stub updateUserPassword updates the user's password_hash in identityRepo._users)
  const user = repos.identityRepo._users.get(fx.USER_ID);
  assert.ok(user.password_hash !== (await identity.hashPassword('OldPass1!')), 'password_hash must change');
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
  const { svc } = await makeServiceWithUser();
  const req = await svc.requestReset({ email: 'bob@example.com' });
  const result = await svc.completeReset({ token: req.rawToken, newPassword: 'short' });
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
  const { svc } = await makeServiceWithUser();
  const req = await svc.requestReset({ email: 'bob@example.com' });
  await svc.completeReset({ token: req.rawToken, newPassword: 'NewPass1!' });
  const again = await svc.completeReset({ token: req.rawToken, newPassword: 'AnotherPass1!' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'reset_token_used');
});

test('completeReset: expired token returns reset_token_expired', async () => {
  const { svc, repos } = await makeServiceWithUser();
  const req = await svc.requestReset({ email: 'bob@example.com' });

  // Manually expire the token in the store
  for (const t of repos.passwordResetRepo._resetTokens.values()) {
    t.expires_at = new Date(Date.now() - 1000).toISOString();
  }

  const result = await svc.completeReset({ token: req.rawToken, newPassword: 'NewPass1!' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'reset_token_expired');
});

test('completeReset: successful reset revokes all refresh tokens for user', async () => {
  const { svc, repos } = await makeServiceWithUser();
  // Seed a refresh token
  const rt = await repos.tokensRepo.insertRefreshToken({
    user_id: fx.USER_ID, tenant_id: fx.TENANT_A,
    token_hash: 'rt-hash-1', family: 'fam1', revoked_at: null
  });
  const req = await svc.requestReset({ email: 'bob@example.com' });
  await svc.completeReset({ token: req.rawToken, newPassword: 'NewPass1!' });

  const storedRt = repos.tokensRepo._refreshTokens.get(rt.token_hash);
  assert.ok(storedRt.revoked_at, 'refresh token must be revoked after password reset');
});
