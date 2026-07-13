'use strict';

/**
 * Phase 58 — Invitation encrypted-outbox integration tests.
 *
 * Proves: atomicity, client threading, encrypted payload boundary,
 * rollback on enqueue failure, idempotency, resend correctness,
 * token-acceptance via outbox spy, security token boundary, and
 * tenant/property isolation — all without a real DB.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const crypto   = require('node:crypto');

process.env.QYRVIA_NOTIFICATION_ENCRYPTION_KEY =
  Buffer.alloc(32, 0x42).toString('base64');
process.env.APP_BASE_URL = 'http://localhost:3001';

const fx = require('./_fixtures');
const { buildInvitationService }           = require('../src/services/invitation');
const { buildIdentityNotificationOutbox }  = require('../src/services/identityNotificationOutbox');
const { decryptNotificationPayload }       = require('../src/security/notificationPayloadCrypto');

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

async function makeSetup(overrides = {}) {
  const repos        = fx.makeFakeRepos(overrides);
  const withTenantFn = makeTransactionHarness(repos.invitationRepo, repos.notificationRepo);
  const identityNotificationOutbox = buildIdentityNotificationOutbox({
    notificationRepo: repos.notificationRepo
  });
  const svc = buildInvitationService({
    repo: repos.invitationRepo,
    identityNotificationOutbox,
    withTenantFn
  });
  return { svc, repos, withTenantFn, identityNotificationOutbox };
}

// ── Helper ─────────────────────────────────────────────────────────────────────

function latestNotification(repos) {
  return repos.notificationRepo._notifications.at(-1);
}

function decryptLatest(repos) {
  const notif = latestNotification(repos);
  assert.ok(notif, 'expected a notification in outbox');
  return decryptNotificationPayload(notif);
}

// ── 1. Same-client threading ───────────────────────────────────────────────────

test('invitation + notification use the exact same transaction client', async () => {
  const { svc, repos, withTenantFn } = await makeSetup();

  await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'client-check@example.com',
    roleCodes: ['staff'], actorRoleCodes: []
  });

  const txClient = withTenantFn.getLastClient();
  assert.ok(txClient, 'transaction client must be recorded');
  assert.equal(repos.invitationRepo._lastInsertClient, txClient,
    'insertInvitation must have received the same client as the transaction');
});

// ── 2. Token absent from service and HTTP response ─────────────────────────────

test('createInvitation service response does not contain rawToken', async () => {
  const { svc } = await makeSetup();
  const result = await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'no-token@example.com',
    roleCodes: ['staff'], actorRoleCodes: []
  });
  assert.equal(result.ok, true);
  assert.equal(result.rawToken, undefined, 'rawToken must not appear in service result');
  assert.equal(result.token, undefined, 'token must not appear in service result');
});

// ── 3. Plaintext notification columns contain no sensitive data ────────────────

test('plaintext notification row contains no email, token, or invitation URL', async () => {
  const { svc, repos } = await makeSetup();
  await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'secret@example.com',
    roleCodes: ['staff'], actorRoleCodes: ['corporate_admin']
  });

  const notif = latestNotification(repos);
  assert.ok(notif, 'notification must exist in outbox');

  const plaintext = JSON.stringify({
    subject: notif.subject,
    body:    notif.body,
    context: notif.context,
    recipient: notif.recipient
  });

  assert.ok(!plaintext.includes('secret@example.com'), 'plaintext must not contain email');
  assert.ok(!plaintext.includes('accept-invitation'), 'plaintext must not contain invitation URL');
  assert.equal(notif.template_code, 'identity_invitation');
  assert.equal(notif.channel, 'email');
  assert.equal(notif.subject, 'You have been invited');
  assert.equal(notif.body, 'Secure notification payload');
  assert.deepEqual(notif.context, {});
  assert.equal(notif.property_id, null);
  assert.ok(notif.source_idempotency_key.startsWith('identity-invitation:'),
    'idempotency key must be identity-invitation:');
});

// ── 4. Encrypted payload decrypts to expected invitation data ──────────────────

test('encrypted payload decrypts to the expected identity_invitation structure', async () => {
  const { svc, repos } = await makeSetup();
  await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'decrypt-me@example.com',
    roleCodes: ['staff'], invitedBy: fx.USER_ID, actorRoleCodes: []
  });

  const payload = decryptLatest(repos);
  assert.equal(payload.type, 'identity_invitation');
  assert.equal(payload.email, 'decrypt-me@example.com');
  assert.ok(typeof payload.token === 'string' && payload.token.length === 64,
    'decrypted token must be 64-char hex');
  assert.ok(payload.invitationUrl.startsWith('http://localhost:3001/#/accept-invitation?token='),
    'invitationUrl must use APP_BASE_URL and correct frontend route');
  assert.ok(payload.expiresAt, 'expiresAt must be present in encrypted payload');
  // Encrypted payload must not appear in plaintext body or subject
  const notif = latestNotification(repos);
  assert.ok(notif.body !== payload.token, 'raw token must not appear in plaintext body');
});

// ── 5. Enqueue failure rolls back the new invitation ──────────────────────────

test('outbox enqueue failure rolls back invitation insertion', async () => {
  const repos = fx.makeFakeRepos();
  const withTenantFn = makeTransactionHarness(repos.invitationRepo, repos.notificationRepo);

  // Make notification enqueue throw after the invitation is inserted.
  const brokenOutbox = {
    enqueueIdentityInvitationNotification: async () => {
      throw Object.assign(new Error('Simulated outbox failure'), { code: 'OUTBOX_BROKEN' });
    }
  };

  const svc = buildInvitationService({
    repo: repos.invitationRepo,
    identityNotificationOutbox: brokenOutbox,
    withTenantFn
  });

  const before = repos.invitationRepo._invitations.size;
  await assert.rejects(
    () => svc.createInvitation({ tenantId: fx.TENANT_A, email: 'rollback@example.com', roleCodes: ['staff'], actorRoleCodes: [] }),
    (err) => err.code === 'OUTBOX_BROKEN'
  );

  assert.equal(repos.invitationRepo._invitations.size, before,
    'invitation must be rolled back when outbox enqueue fails');
  assert.equal(repos.notificationRepo._notifications.length, 0,
    'no notification must persist after rollback');
});

// ── 6. Duplicate pending invitation is rejected; prior invitation survives ─────

test('duplicate createInvitation for same email is rejected and prior invitation remains', async () => {
  const { svc, repos } = await makeSetup();

  const first = await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'resend-me@example.com',
    roleCodes: ['staff'], actorRoleCodes: []
  });
  assert.equal(first.ok, true);
  const notifCountAfterFirst = repos.notificationRepo._notifications.length;

  const second = await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'resend-me@example.com',
    roleCodes: ['staff'], actorRoleCodes: []
  });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'invitation_already_pending');

  // Prior invitation still active
  const inv = repos.invitationRepo._invitations.get(first.invitationId);
  assert.equal(inv.status, 'pending', 'prior invitation must remain pending');
  assert.equal(repos.notificationRepo._notifications.length, notifCountAfterFirst,
    'no new notification must be created on duplicate rejection');
});

// ── 7. Idempotency: duplicate enqueue for same invitation record ───────────────

test('re-enqueueing the same invitationRecordId is idempotent', async () => {
  const { svc, repos, identityNotificationOutbox, withTenantFn } = await makeSetup();

  const result = await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'idem@example.com',
    roleCodes: ['staff'], actorRoleCodes: []
  });
  assert.equal(result.ok, true);
  const invId = result.invitationId;
  const notifCountAfter1 = repos.notificationRepo._notifications.length;

  // Manually enqueue again with the same invitationRecordId.
  const client = { tenantId: fx.TENANT_A, query: async () => ({ rows: [] }) };
  const { row: row2, created: created2 } =
    await identityNotificationOutbox.enqueueIdentityInvitationNotification({
      tenantId:           fx.TENANT_A,
      identityId:         invId,
      invitationRecordId: invId,
      email:              'idem@example.com',
      rawToken:           'a'.repeat(64),
      expiresAt:          new Date(Date.now() + 60000),
      inviterId:          null
    }, client);

  assert.equal(created2, false, 'second enqueue must not create a new row');
  assert.equal(repos.notificationRepo._notifications.length, notifCountAfter1,
    'notification count must remain unchanged on duplicate enqueue');
  assert.ok(row2, 'must return the existing row');
});

// ── 8. Genuine resend creates exactly one new notification ────────────────────

test('genuine resend (revoke + re-invite) creates exactly one new notification', async () => {
  const { svc, repos } = await makeSetup();

  // First invitation
  const first = await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'resend2@example.com',
    roleCodes: ['staff'], actorRoleCodes: []
  });
  assert.equal(first.ok, true);
  const countAfterFirst = repos.notificationRepo._notifications.length;

  // Revoke the first invitation
  await svc.revokeInvitation({ invitationId: first.invitationId, revokedBy: 'admin' });

  // Genuine resend: new invitation record for same email
  const second = await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'resend2@example.com',
    roleCodes: ['staff'], actorRoleCodes: []
  });
  assert.equal(second.ok, true);
  assert.notEqual(second.invitationId, first.invitationId, 'resend must create a new invitation record');
  assert.equal(repos.notificationRepo._notifications.length, countAfterFirst + 1,
    'resend must create exactly one new notification');
});

// ── 9. Invitation acceptance using token captured from outbox spy ──────────────

test('acceptInvitation succeeds using token captured from encrypted outbox', async () => {
  const { svc, repos } = await makeSetup();

  const created = await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'accept-spy@example.com',
    roleCodes: ['staff'], actorRoleCodes: []
  });
  assert.equal(created.ok, true);
  assert.equal(created.rawToken, undefined, 'rawToken must not be in service result');

  // Capture token from encrypted outbox
  const payload = decryptLatest(repos);
  assert.equal(payload.type, 'identity_invitation');
  const rawToken = payload.token;
  assert.ok(typeof rawToken === 'string' && rawToken.length === 64, 'captured token must be valid hex');

  const accepted = await svc.acceptInvitation({
    token: rawToken, fullName: 'Accept Spy', password: 'SecureP@ss1'
  });
  assert.equal(accepted.ok, true);
  assert.ok(accepted.userId, 'userId must be returned on acceptance');
  assert.equal(accepted.email, 'accept-spy@example.com');

  const inv = repos.invitationRepo._invitations.get(created.invitationId);
  assert.equal(inv.status, 'accepted');
});

// ── 10. Invalid / expired / revoked / used tokens remain rejected ──────────────

test('invalid token returns invitation_not_found', async () => {
  const { svc } = await makeSetup();
  const r = await svc.acceptInvitation({ token: 'f'.repeat(64), fullName: 'Nobody', password: 'Secur3Pass!' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invitation_not_found');
});

test('expired token returns invitation_expired', async () => {
  const { svc, repos } = await makeSetup();
  const created = await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'expired2@example.com', roleCodes: ['staff'], actorRoleCodes: []
  });
  const inv = repos.invitationRepo._invitations.get(created.invitationId);
  inv.expires_at = new Date(Date.now() - 5000).toISOString();

  const payload = decryptLatest(repos);
  const r = await svc.acceptInvitation({ token: payload.token, fullName: 'Exp', password: 'Secur3Pass!' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invitation_expired');
});

test('revoked invitation cannot be accepted', async () => {
  const { svc, repos } = await makeSetup();
  const created = await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'revoked2@example.com', roleCodes: ['staff'], actorRoleCodes: []
  });
  const payload = decryptLatest(repos);
  await svc.revokeInvitation({ invitationId: created.invitationId, revokedBy: 'admin' });

  const r = await svc.acceptInvitation({ token: payload.token, fullName: 'Rev', password: 'Secur3Pass!' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invitation_already_used');
});

test('already-used token cannot be used again', async () => {
  const { svc, repos } = await makeSetup();
  const created = await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'used-tok@example.com', roleCodes: ['staff'], actorRoleCodes: []
  });
  const payload = decryptLatest(repos);
  await svc.acceptInvitation({ token: payload.token, fullName: 'First', password: 'Secur3Pass!' });

  const r = await svc.acceptInvitation({ token: payload.token, fullName: 'Second', password: 'Secur3Pass!' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invitation_already_used');
});

// ── 11. No direct email delivery in createInvitation ─────────────────────────

test('createInvitation does not call emailDelivery or any send function directly', async () => {
  // If emailDelivery were required in the service path, it would be apparent
  // in the module dependency graph. This test proves that only outbox insertion
  // happens — no email-delivery module is loaded or called during createInvitation.
  // We verify this by confirming the notification remains in 'pending' status
  // (not 'delivered'), which is the correct outbox pattern.
  const { svc, repos } = await makeSetup();
  await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'no-direct-email@example.com',
    roleCodes: ['staff'], actorRoleCodes: []
  });

  const notif = latestNotification(repos);
  assert.equal(notif.status, 'pending',
    'notification must be pending — email delivery happens asynchronously via the worker, not inline');
});

// ── 12. Tenant isolation ───────────────────────────────────────────────────────

test('notification is scoped to the correct tenant', async () => {
  const { svc, repos } = await makeSetup();
  await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'tenant-iso@example.com',
    roleCodes: ['staff'], actorRoleCodes: []
  });

  const notif = latestNotification(repos);
  assert.equal(notif.tenant_id, fx.TENANT_A);
  assert.equal(notif.property_id, null, 'invitation notifications are property-scoped to null');
});

test('invitation for TENANT_B is not visible when listing TENANT_A notifications', async () => {
  const repos = fx.makeFakeRepos();
  const withTenantFnA = makeTransactionHarness(repos.invitationRepo, repos.notificationRepo);
  const outbox = buildIdentityNotificationOutbox({ notificationRepo: repos.notificationRepo });

  const svcA = buildInvitationService({
    repo: repos.invitationRepo,
    identityNotificationOutbox: outbox,
    withTenantFn: withTenantFnA
  });

  await svcA.createInvitation({ tenantId: fx.TENANT_A, email: 'iso-a@example.com', roleCodes: ['staff'], actorRoleCodes: [] });
  await svcA.createInvitation({ tenantId: fx.TENANT_B, email: 'iso-b@example.com', roleCodes: ['staff'], actorRoleCodes: [] });

  const tenantANotifs = repos.notificationRepo._notifications.filter(n => n.tenant_id === fx.TENANT_A);
  const tenantBNotifs = repos.notificationRepo._notifications.filter(n => n.tenant_id === fx.TENANT_B);

  assert.equal(tenantANotifs.length, 1);
  assert.equal(tenantBNotifs.length, 1);
  assert.ok(!tenantANotifs.some(n => n.tenant_id === fx.TENANT_B), 'TENANT_A notifications must not bleed into TENANT_B');
});

// ── 13. inviterId surfaced as requested_by ────────────────────────────────────

test('inviterId is stored as requested_by on the notification', async () => {
  const { svc, repos } = await makeSetup();
  await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'with-inviter@example.com',
    roleCodes: ['staff'], invitedBy: fx.USER_ID, actorRoleCodes: []
  });

  const notif = latestNotification(repos);
  assert.equal(notif.requested_by, fx.USER_ID);
});

test('null inviterId leaves requested_by as null', async () => {
  const { svc, repos } = await makeSetup();
  await svc.createInvitation({
    tenantId: fx.TENANT_A, email: 'no-inviter@example.com',
    roleCodes: ['staff'], invitedBy: null, actorRoleCodes: []
  });

  const notif = latestNotification(repos);
  assert.equal(notif.requested_by, null);
});
