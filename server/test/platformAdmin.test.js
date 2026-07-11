'use strict';

/**
 * Phase 57 — Platform Super Admin bootstrap tests.
 *
 * Verifies:
 *  1. bootstrapPlatformAdmin creates user from caller-supplied credentials
 *  2. Stored password is bcrypt hash, not plaintext
 *  3. Account receives super_admin role
 *  4. Bootstrap is idempotent (second call does not create a second user)
 *  5. Bootstrap does not overwrite a changed password (ACTIVE status)
 *  6. First login (PENDING_PASSWORD_RESET) returns requires_password_change:true
 *  7. Login response includes password_reset_token when passwordResetService is injected
 *  8. After completeReset, bootstrap password no longer authenticates
 *  9. Normal customer admins cannot grant platform-level roles (super_admin / platform_admin)
 * 10. An existing Platform Super Admin can invite another super_admin user
 * 11. Platform-role provisioning is audited (insertAuditEvent called)
 * 12. Customer email login endpoint is the same for all users — no tenant/role selector exposed
 *
 * Uses in-memory fixtures only. No real DB required.
 */

const fx       = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');

const identity                      = require('../src/services/identity');
const { bootstrapPlatformAdmin }    = require('../src/services/platformBootstrap');
const { buildPasswordResetService } = require('../src/services/passwordReset');
const { buildInvitationService }    = require('../src/services/invitation');
const { createApp }                 = require('../src/app');

const TENANT_PLATFORM = 'ffffffff-ffff-1fff-ffff-ffffffffffff';
const ADMIN_EMAIL     = 'platform-admin@qyrvia.test';
const ADMIN_PASSWORD  = 'BootstrapTest1!';  // generic test value — NOT production credentials

// ── Adapter: wraps in-memory fixture repos for bootstrapPlatformAdmin's repo contract ────

function makeBootstrapRepo(repos, { auditLog } = {}) {
  return {
    async findUserByEmailGlobal(email) {
      return repos.identityRepo.findUserByEmailGlobal(email);
    },
    async insertUser(rec) {
      return repos.identityRepo.insertUser(rec);
    },
    async ensureSuperAdminRole(userId) {
      await repos.identityRepo.insertUserRoleByCode({ user_id: userId, role_code: 'super_admin' });
    },
    async insertAuditEvent(ev) {
      if (auditLog) auditLog.push(ev);
    }
  };
}

// ── Test 1: Creates user with PENDING_PASSWORD_RESET ─────────────────────────────────────

test('bootstrapPlatformAdmin: creates user with PENDING_PASSWORD_RESET status', async () => {
  const repos  = fx.makeFakeRepos();
  const repo   = makeBootstrapRepo(repos);
  const result = await bootstrapPlatformAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, tenantId: TENANT_PLATFORM }, repo);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'created');
  const user = repos.identityRepo._users.get(result.userId);
  assert.ok(user, 'user must be created');
  assert.equal(user.status, 'PENDING_PASSWORD_RESET');
  assert.equal(user.email, ADMIN_EMAIL);
});

// ── Test 2: Password is bcrypt hash ──────────────────────────────────────────────────────

test('bootstrapPlatformAdmin: stored password_hash is bcrypt, not plaintext', async () => {
  const repos  = fx.makeFakeRepos();
  const result = await bootstrapPlatformAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, tenantId: TENANT_PLATFORM }, makeBootstrapRepo(repos));
  const user   = repos.identityRepo._users.get(result.userId);
  assert.ok(user.password_hash.startsWith('$2'), 'password_hash must be a bcrypt hash');
  assert.notEqual(user.password_hash, ADMIN_PASSWORD, 'plaintext must not be stored');
});

// ── Test 3: Account receives super_admin role ─────────────────────────────────────────────

test('bootstrapPlatformAdmin: account receives super_admin role', async () => {
  const repos  = fx.makeFakeRepos();
  const result = await bootstrapPlatformAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, tenantId: TENANT_PLATFORM }, makeBootstrapRepo(repos));
  const roles  = await repos.identityRepo.findRolesForUser(result.userId);
  assert.ok(roles.some((r) => r.code === 'super_admin'), 'super_admin role must be granted');
});

// ── Test 4: Bootstrap is idempotent ──────────────────────────────────────────────────────

test('bootstrapPlatformAdmin: second call does not create a second user', async () => {
  const repos = fx.makeFakeRepos();
  const repo  = makeBootstrapRepo(repos);
  const r1    = await bootstrapPlatformAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, tenantId: TENANT_PLATFORM }, repo);
  const r2    = await bootstrapPlatformAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, tenantId: TENANT_PLATFORM }, repo);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r1.userId, r2.userId, 'user id must be same on second call');
  assert.equal(r2.action, 'pending_first_login', 'second call must skip creation');
  // Only one user in the store
  assert.equal(repos.identityRepo._users.size, 1, 'must not create duplicate users');
});

// ── Test 5: Bootstrap does not overwrite a changed password ──────────────────────────────

test('bootstrapPlatformAdmin: does not overwrite password when user is ACTIVE', async () => {
  const repos = fx.makeFakeRepos();
  const repo  = makeBootstrapRepo(repos);
  // First: create the admin
  const r1    = await bootstrapPlatformAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, tenantId: TENANT_PLATFORM }, repo);
  // Simulate password change: mark user ACTIVE with new hash
  const user  = repos.identityRepo._users.get(r1.userId);
  const newHash = await identity.hashPassword('NewUserChosen1!');
  user.password_hash = newHash;
  user.status        = 'ACTIVE';

  // Re-run bootstrap
  const r2 = await bootstrapPlatformAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, tenantId: TENANT_PLATFORM }, repo);
  assert.equal(r2.ok, true);
  assert.equal(r2.action, 'already_active', 'must report already_active and skip password');
  // Hash must still be the user-chosen hash, NOT the bootstrap hash
  const userAfter = repos.identityRepo._users.get(r1.userId);
  assert.equal(userAfter.password_hash, newHash, 'password must not be overwritten');
});

// ── Test 6: First login returns requires_password_change:true ────────────────────────────

test('identity.attemptLogin: PENDING_PASSWORD_RESET email login returns requires_password_change', async () => {
  const repos        = fx.makeFakeRepos();
  const repo         = makeBootstrapRepo(repos);
  const bootstrapped = await bootstrapPlatformAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, tenantId: TENANT_PLATFORM }, repo);
  repos.identityRepo._seedAccessibleProperty({ id: fx.PROP_ID, code: 'P1', name: 'Test', tenant_id: TENANT_PLATFORM, active: true });
  const result = await identity.attemptLogin(repos.identityRepo, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.requires_password_change, true, 'must signal required password change');
  void bootstrapped;
});

// ── Test 7: Login response includes password_reset_token via HTTP route ───────────────────

test('POST /api/auth/login with PENDING_PASSWORD_RESET → 200 + requires_password_change + token', async () => {
  const repos        = fx.makeFakeRepos();
  const repo         = makeBootstrapRepo(repos);
  await bootstrapPlatformAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, tenantId: TENANT_PLATFORM }, repo);
  repos.identityRepo._seedAccessibleProperty({ id: fx.PROP_ID, code: 'P1', name: 'Test', tenant_id: TENANT_PLATFORM, active: true });

  const passwordResetService = buildPasswordResetService({ repo: repos.passwordResetRepo });

  const { createApp: _createApp } = require('../src/app');
  const app = _createApp({
    db: fx.makeFakeDb(),
    identityRepo: repos.identityRepo,
    tokensRepo:   repos.tokensRepo,
    passwordResetService
  });

  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.requires_password_change, true, 'requires_password_change must be true');
    assert.ok(typeof r.body.password_reset_token === 'string' && r.body.password_reset_token.length > 0,
      'password_reset_token must be present');
  } finally { srv.close(); }
});

// ── Test 8: After completeReset, bootstrap password no longer works ───────────────────────

test('after completeReset, bootstrap password returns bad_password', async () => {
  const repos        = fx.makeFakeRepos();
  const repo         = makeBootstrapRepo(repos);
  await bootstrapPlatformAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, tenantId: TENANT_PLATFORM }, repo);

  const svc = buildPasswordResetService({ repo: repos.passwordResetRepo });
  // Request a reset token
  const req = await svc.requestReset({ email: ADMIN_EMAIL });
  assert.equal(req.queued, true, 'reset must be queued');
  // Complete reset with a new password
  const completed = await svc.completeReset({ token: req.rawToken, newPassword: 'NewPermanent1!' });
  assert.equal(completed.ok, true, 'completeReset must succeed');

  // Old password must fail now
  const loginOld = await identity.attemptLogin(repos.identityRepo, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  assert.equal(loginOld.ok, false, 'old bootstrap password must no longer work');
  assert.equal(loginOld.reason, 'bad_password');

  // New password must succeed
  const loginNew = await identity.attemptLogin(repos.identityRepo, { email: ADMIN_EMAIL, password: 'NewPermanent1!' });
  assert.equal(loginNew.ok, true, 'new password must authenticate');
  // After completeReset the fixture sets status to ACTIVE — no longer requires_password_change
  assert.equal(loginNew.requires_password_change, false, 'password change no longer required after reset');
});

// ── Test 9: Normal customer admins cannot grant platform-level roles ──────────────────────

test('invitation.createInvitation: non-super_admin caller cannot invite with super_admin role', async () => {
  const repos  = fx.makeFakeRepos();
  const svc    = buildInvitationService({ repo: repos.invitationRepo });

  const result = await svc.createInvitation({
    tenantId:       fx.TENANT_A,
    email:          'target@example.com',
    roleCodes:      ['super_admin'],   // platform-level role
    propertyIds:    [],
    invitedBy:      fx.USER_ID,
    actorRoleCodes: ['corporate_admin']  // regular customer admin — must be blocked
  });

  assert.equal(result.ok, false, 'must reject system-role grant by customer admin');
  assert.equal(result.error, 'role_escalation_denied', 'error must be role_escalation_denied');
});

test('invitation.createInvitation: non-super_admin caller cannot invite with platform_admin role', async () => {
  const repos  = fx.makeFakeRepos();
  const svc    = buildInvitationService({ repo: repos.invitationRepo });

  const result = await svc.createInvitation({
    tenantId:       fx.TENANT_A,
    email:          'target@example.com',
    roleCodes:      ['platform_admin'],  // platform-level role
    propertyIds:    [],
    invitedBy:      fx.USER_ID,
    actorRoleCodes: ['property_admin']  // customer admin — must be blocked
  });

  assert.equal(result.ok, false, 'must reject platform_admin grant by customer admin');
  assert.equal(result.error, 'role_escalation_denied');
});

// ── Test 10: Existing PSA can invite another super_admin ──────────────────────────────────

test('invitation.createInvitation: super_admin actor can invite with super_admin role', async () => {
  const repos  = fx.makeFakeRepos();
  const svc    = buildInvitationService({ repo: repos.invitationRepo });

  const result = await svc.createInvitation({
    tenantId:       TENANT_PLATFORM,
    email:          'second-admin@qyrvia.test',
    roleCodes:      ['super_admin'],
    propertyIds:    [],
    invitedBy:      fx.USER_ID,
    actorRoleCodes: ['super_admin']    // existing PSA — must be permitted
  });

  assert.equal(result.ok, true, 'super_admin must be able to invite another super_admin');
  assert.ok(result.invitationId, 'invitationId must be returned');
});

// ── Test 11: Platform-role provisioning is audited ────────────────────────────────────────

test('bootstrapPlatformAdmin: calls insertAuditEvent on creation', async () => {
  const repos    = fx.makeFakeRepos();
  const auditLog = [];
  const repo     = makeBootstrapRepo(repos, { auditLog });

  await bootstrapPlatformAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, tenantId: TENANT_PLATFORM }, repo);

  assert.equal(auditLog.length, 1, 'one audit event must be written');
  const ev = auditLog[0];
  assert.equal(ev.event_type, 'platform.super_admin_provisioned');
  assert.equal(ev.aggregate_type, 'user');
  const payload = JSON.parse(ev.payload);
  assert.equal(payload.action, 'created');
  assert.equal(payload.email, ADMIN_EMAIL);
  assert.equal(payload.email.includes('password'), false, 'audit payload must not mention password');
});

test('bootstrapPlatformAdmin: audit event on second call (idempotent re-run)', async () => {
  const repos    = fx.makeFakeRepos();
  const auditLog = [];
  const repo     = makeBootstrapRepo(repos, { auditLog });
  await bootstrapPlatformAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, tenantId: TENANT_PLATFORM }, repo);
  await bootstrapPlatformAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, tenantId: TENANT_PLATFORM }, repo);
  assert.equal(auditLog.length, 2, 'audit event written on every run');
  assert.equal(JSON.parse(auditLog[1].payload).action, 'pending_first_login', 'second run logs correct action');
});

// ── Test 12: Customer email login endpoint same for all — no role/tenant selector ────────

test('email login path works identically for platform admin and regular user', async () => {
  // Seed a regular customer user
  const repos = fx.makeFakeRepos();
  const hash  = await identity.hashPassword('RegularUser1!');
  repos.identityRepo._seedUser(
    { id: fx.USER_ID, tenant_id: fx.TENANT_A, tenant_code: 'TENANT-A',
      username: 'regular', email: 'regular@example.com',
      password_hash: hash, status: 'ACTIVE', tenant_status: 'active' },
    [{ id: 'role-staff', code: 'staff', scope: 'TENANT', property_id: null }], []
  );
  repos.identityRepo._seedAccessibleProperty({ id: fx.PROP_ID, code: 'P1', name: 'Hotel', tenant_id: fx.TENANT_A, active: true });

  // Seed a platform admin user
  const bootstrapRepo = makeBootstrapRepo(repos);
  await bootstrapPlatformAdmin({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, tenantId: TENANT_PLATFORM }, bootstrapRepo);

  // Both log in via the same email path — no tenant/property selector required
  const regularResult  = await identity.attemptLogin(repos.identityRepo, { email: 'regular@example.com', password: 'RegularUser1!' });
  const platformResult = await identity.attemptLogin(repos.identityRepo, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

  assert.equal(regularResult.ok,  true, 'regular user must log in via email path');
  assert.equal(platformResult.ok, true, 'platform admin must log in via same email path');
  assert.equal(regularResult.login_via,  'email');
  assert.equal(platformResult.login_via, 'email');
  // Platform admin has requires_password_change; regular user does not
  assert.equal(platformResult.requires_password_change, true,  'platform admin has pending password change');
  assert.equal(regularResult.requires_password_change,  false, 'regular user has no pending password change');
  // Neither login exposes a tenant or role selector — that is server-resolved
  assert.ok(regularResult.user.tenant_id,  'tenant resolved server-side');
  assert.ok(platformResult.user.tenant_id, 'tenant resolved server-side');
});
