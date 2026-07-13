'use strict';

/**
 * Phase 57 — Tenant provisioning service unit tests.
 *
 * Uses a mock pool (no real Postgres). Validates:
 *   - Input validation
 *   - Transaction sequence (BEGIN/INSERT tenant/INSERT property/COMMIT)
 *   - Duplicate code handling
 *   - Invitation is created post-commit
 *   - Invitation failure is non-fatal
 */

process.env.QYRVIA_NOTIFICATION_ENCRYPTION_KEY =
  Buffer.alloc(32, 0x42).toString('base64');
process.env.APP_BASE_URL = 'http://localhost:3001';

const fx       = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const crypto   = require('node:crypto');

const { buildTenantProvisioningService }   = require('../src/services/tenantProvisioning');
const { buildInvitationService }           = require('../src/services/invitation');
const { buildIdentityNotificationOutbox }  = require('../src/services/identityNotificationOutbox');

// ── Mock pool ─────────────────────────────────────────────────────────────────

function makeMockPool({ failOn, dupCode } = {}) {
  const queries = [];
  let tenantIdVal  = crypto.randomUUID();
  let propertyIdVal = crypto.randomUUID();

  const client = {
    _queries: queries,
    async query(sql, params) {
      const tag = sql.trim().replace(/\s+/g, ' ').slice(0, 80);
      queries.push({ tag, params });

      if (failOn && tag.includes(failOn)) {
        const err = new Error('mock error: ' + failOn);
        if (dupCode) err.code = '23505';
        throw err;
      }

      if (/INSERT INTO tenants/i.test(sql))    return { rows: [{ id: tenantIdVal }] };
      if (/INSERT INTO properties/i.test(sql)) return { rows: [{ id: propertyIdVal }] };
      return { rows: [] };
    },
    _tenantId()   { return tenantIdVal; },
    _propertyId() { return propertyIdVal; },
    async release() {}
  };

  return {
    _client: client,
    _queries: queries,
    async connect() { return client; }
  };
}

const VALID_INPUT = {
  companyName:  'Acme Hotels',
  companyCode:  'ACME',
  propertyName: 'Acme Downtown',
  propertyCode: 'ACME-DT',
  ownerEmail:   'owner@acme.com',
  timezone:     'Asia/Colombo'
};

const CTX = { actorId: 'platform-admin-1', actorName: 'PlatformAdmin', roleCodes: ['platform_admin'], requestId: 'req-1' };

function makeProvisioningService(pool, invitationService) {
  return buildTenantProvisioningService({ pool, invitationService });
}

function makeInvitationService() {
  const repos  = fx.makeFakeRepos();
  const outbox = buildIdentityNotificationOutbox({ notificationRepo: repos.notificationRepo });
  const withTenantFn = async (tenantId, cb) => {
    const client = { tenantId, query: async () => ({ rows: [] }) };
    return cb(client);
  };
  return buildInvitationService({
    repo: repos.invitationRepo,
    identityNotificationOutbox: outbox,
    withTenantFn
  });
}

// ── Validation ────────────────────────────────────────────────────────────────

test('provisionTenant: missing companyName returns validation_failed', async () => {
  const svc = makeProvisioningService(makeMockPool(), makeInvitationService());
  const r = await svc.provisionTenant({ ...VALID_INPUT, companyName: '' }, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'validation_failed');
  assert.ok(r.detail.includes('companyName'));
});

test('provisionTenant: companyCode with lowercase returns validation_failed', async () => {
  const svc = makeProvisioningService(makeMockPool(), makeInvitationService());
  const r = await svc.provisionTenant({ ...VALID_INPUT, companyCode: 'acme' }, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'validation_failed');
  assert.ok(r.detail.includes('companyCode'));
});

test('provisionTenant: invalid companyCode (too short) returns validation_failed', async () => {
  const svc = makeProvisioningService(makeMockPool(), makeInvitationService());
  const r = await svc.provisionTenant({ ...VALID_INPUT, companyCode: 'A' }, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'validation_failed');
});

test('provisionTenant: invalid ownerEmail returns validation_failed', async () => {
  const svc = makeProvisioningService(makeMockPool(), makeInvitationService());
  const r = await svc.provisionTenant({ ...VALID_INPUT, ownerEmail: 'not-email' }, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'validation_failed');
  assert.ok(r.detail.includes('ownerEmail'));
});

test('provisionTenant: missing propertyName returns validation_failed', async () => {
  const svc = makeProvisioningService(makeMockPool(), makeInvitationService());
  const r = await svc.provisionTenant({ ...VALID_INPUT, propertyName: '' }, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'validation_failed');
});

test('provisionTenant: null input returns invalid_input', async () => {
  const svc = makeProvisioningService(makeMockPool(), makeInvitationService());
  const r = await svc.provisionTenant(null, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_input');
});

// ── Happy path ────────────────────────────────────────────────────────────────

test('provisionTenant: valid input returns ok:true with tenantId and propertyId', async () => {
  const pool = makeMockPool();
  const svc  = makeProvisioningService(pool, makeInvitationService());
  const r    = await svc.provisionTenant(VALID_INPUT, CTX);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.tenantId,   'tenantId missing');
  assert.ok(r.propertyId, 'propertyId missing');
});

test('provisionTenant: transaction includes BEGIN and COMMIT', async () => {
  const pool = makeMockPool();
  const svc  = makeProvisioningService(pool, makeInvitationService());
  await svc.provisionTenant(VALID_INPUT, CTX);
  const tags = pool._queries.map(q => q.tag);
  assert.ok(tags.some(t => /BEGIN/i.test(t)), 'BEGIN missing');
  assert.ok(tags.some(t => /COMMIT/i.test(t)), 'COMMIT missing');
});

test('provisionTenant: INSERT INTO tenants is called with companyCode uppercased', async () => {
  const pool = makeMockPool();
  const svc  = makeProvisioningService(pool, makeInvitationService());
  await svc.provisionTenant(VALID_INPUT, CTX);
  const tenantInsert = pool._queries.find(q => /INSERT INTO tenants/i.test(q.tag));
  assert.ok(tenantInsert, 'INSERT INTO tenants missing');
  assert.equal(tenantInsert.params[1], 'ACME'); // companyCode
});

test('provisionTenant: invitation is created with invitationId and email (no rawToken)', async () => {
  const pool = makeMockPool();
  const svc  = makeProvisioningService(pool, makeInvitationService());
  const r    = await svc.provisionTenant(VALID_INPUT, CTX);
  assert.equal(r.ok, true);
  assert.ok(r.invitation, 'invitation should be present');
  assert.ok(r.invitation.invitationId, 'invitationId must be returned');
  assert.equal(r.invitation.email, 'owner@acme.com');
  assert.equal(r.invitation.rawToken, undefined, 'rawToken must not be returned — token is in encrypted outbox only');
});

// ── Duplicate code ────────────────────────────────────────────────────────────

test('provisionTenant: 23505 from DB returns duplicate_code', async () => {
  const pool = makeMockPool({ failOn: 'INSERT INTO tenants', dupCode: true });
  const svc  = makeProvisioningService(pool, makeInvitationService());
  const r    = await svc.provisionTenant(VALID_INPUT, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'duplicate_code');
});

// ── Invitation failure is non-fatal ───────────────────────────────────────────

test('provisionTenant: invitation failure does not fail the whole call', async () => {
  const pool = makeMockPool();
  // An invitation service that always fails
  const brokenInvSvc = { createInvitation: async () => ({ ok: false, error: 'some_error' }) };
  const svc = makeProvisioningService(pool, brokenInvSvc);
  const r   = await svc.provisionTenant(VALID_INPUT, CTX);
  assert.equal(r.ok, true, 'provisioning must succeed even when invite fails');
  assert.equal(r.invitation, null);
  assert.ok(r.invitationError, 'invitationError should report the failure');
});
