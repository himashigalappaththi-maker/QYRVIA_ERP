'use strict';

/**
 * Phase 57/58 — Invitation service unit tests.
 *
 * Uses in-memory stubs from _fixtures.js. No real DB required.
 * Tokens are never returned by the service — captured via outbox spy.
 */

process.env.QYRVIA_NOTIFICATION_ENCRYPTION_KEY =
  Buffer.alloc(32, 0x42).toString('base64');
process.env.APP_BASE_URL = 'http://localhost:3001';

const fx       = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { buildInvitationService }           = require('../src/services/invitation');
const { buildIdentityNotificationOutbox }  = require('../src/services/identityNotificationOutbox');
const { decryptNotificationPayload }       = require('../src/security/notificationPayloadCrypto');

const TENANT_ID = fx.TENANT_A;

// ── Transaction harness ────────────────────────────────────────────────────────

function makeTransactionHarness(invitationRepo, notificationRepo) {
  let _lastClient = null;

  async function withTenantFn(tenantId, cb) {
    const invSnapshot = new Map(
      Array.from(invitationRepo._invitations.entries())
        .map(([k, v]) => [k, Object.assign({}, v)])
    );
    const notifSnapshot = notificationRepo._notifications.slice();

    _lastClient = {
      tenantId,
      _id:   'tx-' + Math.random().toString(36).slice(2),
      query: async () => ({ rows: [] })
    };

    try {
      const result = await cb(_lastClient);
      return result;
    } catch (err) {
      invitationRepo._invitations.clear();
      for (const [k, v] of invSnapshot) invitationRepo._invitations.set(k, v);
      notificationRepo._notifications.length = 0;
      for (const n of notifSnapshot) notificationRepo._notifications.push(n);
      throw err;
    }
  }

  withTenantFn.getLastClient = () => _lastClient;
  return withTenantFn;
}

function makeService(overrides = {}) {
  const repos  = fx.makeFakeRepos(overrides);
  const withTenantFn = makeTransactionHarness(repos.invitationRepo, repos.notificationRepo);
  const identityNotificationOutbox = buildIdentityNotificationOutbox({
    notificationRepo: repos.notificationRepo
  });
  const svc = buildInvitationService({
    repo: repos.invitationRepo,
    identityNotificationOutbox,
    withTenantFn
  });
  return { svc, repos, withTenantFn };
}

// Helper: decrypt the latest notification to read the raw invitation token.
function captureTokenFromOutbox(repos) {
  const notif = repos.notificationRepo._notifications.at(-1);
  assert.ok(notif, 'expected a notification in outbox');
  return decryptNotificationPayload(notif).token;
}

// ── createInvitation ─────────────────────────────────────────────────────────

test('createInvitation: valid email returns ok:true with invitationId (no rawToken in response)', async () => {
  const { svc, repos } = makeService();
  const result = await svc.createInvitation({
    tenantId: TENANT_ID,
    email: 'bob@example.com',
    roleCodes: ['staff'],
    propertyIds: [fx.PROP_ID],
    invitedBy: null,
    actorRoleCodes: ['corporate_admin']
  });
  assert.equal(result.ok, true);
  assert.ok(result.invitationId, 'invitationId missing');
  assert.equal(result.email, 'bob@example.com');
  assert.ok(result.expiresAt, 'expiresAt missing');
  assert.equal(result.rawToken, undefined, 'rawToken must not be returned by service');
  // Token is accessible only from the encrypted outbox
  const token = captureTokenFromOutbox(repos);
  assert.ok(typeof token === 'string' && token.length === 64, 'outbox token must be 64-char hex');
});

test('createInvitation: invalid email returns invalid_email', async () => {
  const { svc } = makeService();
  const result = await svc.createInvitation({ tenantId: TENANT_ID, email: 'not-an-email', roleCodes: [], actorRoleCodes: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_email');
});

test('createInvitation: email is normalised to lowercase', async () => {
  const { svc } = makeService();
  const result = await svc.createInvitation({
    tenantId: TENANT_ID, email: 'BOB@EXAMPLE.COM',
    roleCodes: ['staff'], actorRoleCodes: []
  });
  assert.equal(result.ok, true);
  assert.equal(result.email, 'bob@example.com');
});

test('createInvitation: duplicate pending invitation returns invitation_already_pending', async () => {
  const { svc } = makeService();
  await svc.createInvitation({ tenantId: TENANT_ID, email: 'dup@example.com', roleCodes: ['staff'], actorRoleCodes: [] });
  const second = await svc.createInvitation({ tenantId: TENANT_ID, email: 'dup@example.com', roleCodes: ['staff'], actorRoleCodes: [] });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'invitation_already_pending');
});

test('createInvitation: non-super_admin cannot invite with system role', async () => {
  const { svc } = makeService();
  const result = await svc.createInvitation({
    tenantId: TENANT_ID, email: 'hacker@example.com',
    roleCodes: ['super_admin'], actorRoleCodes: ['corporate_admin']
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'role_escalation_denied');
});

test('createInvitation: super_admin CAN invite with system role', async () => {
  const { svc } = makeService();
  const result = await svc.createInvitation({
    tenantId: TENANT_ID, email: 'admin@example.com',
    roleCodes: ['platform_admin'], actorRoleCodes: ['super_admin']
  });
  assert.equal(result.ok, true);
});

test('createInvitation: defaults to staff role when roleCodes is empty', async () => {
  const { svc, repos } = makeService();
  const result = await svc.createInvitation({ tenantId: TENANT_ID, email: 'nocode@example.com', roleCodes: [], actorRoleCodes: [] });
  assert.equal(result.ok, true);
  const inv = repos.invitationRepo._invitations.get(result.invitationId);
  assert.deepEqual(inv.role_codes, ['staff']);
});

// ── acceptInvitation ─────────────────────────────────────────────────────────

test('acceptInvitation: valid token creates user and marks invitation accepted', async () => {
  const { svc, repos } = makeService();
  const created = await svc.createInvitation({ tenantId: TENANT_ID, email: 'carol@example.com', roleCodes: ['staff'], actorRoleCodes: [] });
  assert.equal(created.ok, true);

  const token = captureTokenFromOutbox(repos);
  const accepted = await svc.acceptInvitation({ token, fullName: 'Carol Brown', password: 'Secur3Pass!' });
  assert.equal(accepted.ok, true);
  assert.ok(accepted.userId, 'userId missing');
  assert.equal(accepted.email, 'carol@example.com');

  const inv = repos.invitationRepo._invitations.get(created.invitationId);
  assert.equal(inv.status, 'accepted');
});

test('acceptInvitation: invalid token returns invitation_not_found', async () => {
  const { svc } = makeService();
  const result = await svc.acceptInvitation({ token: 'a'.repeat(64), fullName: 'Nobody', password: 'Secur3Pass!' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invitation_not_found');
});

test('acceptInvitation: already-accepted token returns invitation_already_used', async () => {
  const { svc, repos } = makeService();
  const created = await svc.createInvitation({ tenantId: TENANT_ID, email: 'double@example.com', roleCodes: ['staff'], actorRoleCodes: [] });
  const token = captureTokenFromOutbox(repos);
  await svc.acceptInvitation({ token, fullName: 'Double', password: 'Secur3Pass!' });
  const again = await svc.acceptInvitation({ token, fullName: 'Double', password: 'Secur3Pass!' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'invitation_already_used');
});

test('acceptInvitation: expired invitation returns invitation_expired', async () => {
  const { svc, repos } = makeService();
  const created = await svc.createInvitation({ tenantId: TENANT_ID, email: 'expired@example.com', roleCodes: ['staff'], actorRoleCodes: [] });
  // Manually expire the invitation
  const inv = repos.invitationRepo._invitations.get(created.invitationId);
  inv.expires_at = new Date(Date.now() - 1000).toISOString();

  const token = captureTokenFromOutbox(repos);
  const result = await svc.acceptInvitation({ token, fullName: 'Expired', password: 'Secur3Pass!' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invitation_expired');
});

test('acceptInvitation: password too short returns password_too_short', async () => {
  const { svc, repos } = makeService();
  const created = await svc.createInvitation({ tenantId: TENANT_ID, email: 'shortpw@example.com', roleCodes: ['staff'], actorRoleCodes: [] });
  const token = captureTokenFromOutbox(repos);
  const result = await svc.acceptInvitation({ token, fullName: 'Short', password: 'abc' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'password_too_short');
});

test('acceptInvitation: missing fields returns missing_fields', async () => {
  const { svc } = makeService();
  const result = await svc.acceptInvitation({ token: null, fullName: null, password: null });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_fields');
});

test('acceptInvitation: email_already_registered when email is taken globally', async () => {
  const repos = fx.makeFakeRepos();
  const withTenantFn = makeTransactionHarness(repos.invitationRepo, repos.notificationRepo);
  const outbox = buildIdentityNotificationOutbox({ notificationRepo: repos.notificationRepo });
  const svc    = buildInvitationService({ repo: repos.invitationRepo, identityNotificationOutbox: outbox, withTenantFn });

  // Seed an existing user with that email
  repos.identityRepo._seedUser(
    { id: 'existing-u', tenant_id: fx.TENANT_B, username: 'dave', email: 'dave@example.com',
      password_hash: 'x', status: 'ACTIVE' }, [], []
  );

  const created = await svc.createInvitation({ tenantId: TENANT_ID, email: 'dave@example.com', roleCodes: ['staff'], actorRoleCodes: [] });
  const token   = captureTokenFromOutbox(repos);
  const result  = await svc.acceptInvitation({ token, fullName: 'Dave', password: 'Secur3Pass!' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'email_already_registered');
});

// ── revokeInvitation ─────────────────────────────────────────────────────────

test('revokeInvitation: pending invitation can be revoked', async () => {
  const { svc, repos } = makeService();
  const created = await svc.createInvitation({ tenantId: TENANT_ID, email: 'revoke@example.com', roleCodes: ['staff'], actorRoleCodes: [] });
  const result  = await svc.revokeInvitation({ invitationId: created.invitationId, revokedBy: 'admin-1' });
  assert.equal(result.ok, true);
  const inv = repos.invitationRepo._invitations.get(created.invitationId);
  assert.equal(inv.status, 'revoked');
});

test('revokeInvitation: unknown id returns not_found', async () => {
  const { svc } = makeService();
  const result = await svc.revokeInvitation({ invitationId: 'inv_nonexistent', revokedBy: null });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_found');
});

test('revokeInvitation: already-accepted invitation returns not_revocable', async () => {
  const { svc, repos } = makeService();
  const created = await svc.createInvitation({ tenantId: TENANT_ID, email: 'acc@example.com', roleCodes: ['staff'], actorRoleCodes: [] });
  const token = captureTokenFromOutbox(repos);
  await svc.acceptInvitation({ token, fullName: 'Acc', password: 'Secur3Pass!' });
  const result = await svc.revokeInvitation({ invitationId: created.invitationId, revokedBy: null });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_revocable');
});

// ── listInvitations ───────────────────────────────────────────────────────────

test('listInvitations: returns all invitations for tenant', async () => {
  const { svc } = makeService();
  await svc.createInvitation({ tenantId: TENANT_ID, email: 'l1@example.com', roleCodes: ['staff'], actorRoleCodes: [] });
  await svc.createInvitation({ tenantId: TENANT_ID, email: 'l2@example.com', roleCodes: ['staff'], actorRoleCodes: [] });
  const list = await svc.listInvitations({ tenantId: TENANT_ID });
  assert.ok(list.length >= 2);
});

test('listInvitations: status filter works', async () => {
  const { svc } = makeService();
  const i1 = await svc.createInvitation({ tenantId: TENANT_ID, email: 'pend@example.com', roleCodes: ['staff'], actorRoleCodes: [] });
  await svc.revokeInvitation({ invitationId: i1.invitationId, revokedBy: null });
  await svc.createInvitation({ tenantId: TENANT_ID, email: 'still@example.com', roleCodes: ['staff'], actorRoleCodes: [] });
  const pending = await svc.listInvitations({ tenantId: TENANT_ID, status: 'pending' });
  assert.ok(pending.every(i => i.status === 'pending'));
});
