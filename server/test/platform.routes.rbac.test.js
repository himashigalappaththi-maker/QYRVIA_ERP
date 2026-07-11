'use strict';

/**
 * Phase 57 — Platform routes RBAC tests.
 *
 * Verifies that POST /tenants, POST /tenants/:id/invitations, and
 * PATCH /invitations/:id/revoke:
 *
 *  P1.  Unauthenticated caller          → 401
 *  P2.  staff role                      → 403 (platform_role_required)
 *  P3.  company_admin                   → 403
 *  P4.  property_admin                  → 403
 *  P5.  corporate_admin                 → 403
 *  P6.  platform_admin + permissions    → 201
 *  P7.  super_admin (no explicit perms) → 201
 *  P8.  corporate_admin / invitation create   → 403
 *  P9.  platform_admin / invitation create    → 201
 *  P10. corporate_admin / invitation revoke   → 403
 *  P11. super_admin / invitation revoke       → 200
 *  P12. cross-tenant manipulation by corporate_admin → 403 at role layer
 *
 * Uses in-memory repos only. No real DB required.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const crypto   = require('node:crypto');

const fx    = require('./_fixtures');
const { createApp } = require('../src/app');

const PLATFORM_TENANT = 'ffffffff-ffff-1fff-ffff-ffffffffffff';

// Mock platform services so RBAC tests don't depend on service logic.
function buildTestApp(repos) {
  const tenantProvisioningService = {
    async provisionTenant(_body, _ctx) {
      return { ok: true, tenantId: crypto.randomUUID(), propertyId: crypto.randomUUID(), invitation: null };
    }
  };
  const invitationService = {
    async createInvitation(_args, _ctx) {
      return { ok: true, invitationId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
    },
    async revokeInvitation(_args, _ctx) {
      return { ok: true };
    }
  };
  return createApp({
    db: fx.makeFakeDb(),
    identityRepo: repos.identityRepo,
    tokensRepo:   repos.tokensRepo,
    tenantProvisioningService,
    invitationService
  });
}

// Seed a user in identityRepo with specific roles and permissions.
function seedUser(repos, userId, roleCodes, permCodes) {
  repos.identityRepo._seedUser(
    { id: userId, tenant_id: fx.TENANT_A, username: 'u-' + userId.slice(0, 8),
      email: 'u-' + userId.slice(0, 8) + '@qyrvia.test',
      password_hash: '$2b$10$placeholder', full_name: 'Test User',
      status: 'ACTIVE', tenant_status: 'active' },
    roleCodes.map((c) => ({ id: 'role-' + c, code: c, scope: 'TENANT', property_id: null })),
    permCodes
  );
}

// ── P1: unauthenticated → 401 ─────────────────────────────────────────────────

test('platform RBAC P1: POST /tenants without auth header → 401', async () => {
  const repos = fx.makeFakeRepos();
  const app   = buildTestApp(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/platform/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'T1', name: 'Test Tenant' })
    });
    assert.equal(r.status, 401, 'unauthenticated request must be rejected with 401');
  } finally { srv.close(); }
});

// ── P2: staff role → 403 ──────────────────────────────────────────────────────

test('platform RBAC P2: POST /tenants with staff role → 403 platform_role_required', async () => {
  const repos  = fx.makeFakeRepos();
  const userId = crypto.randomUUID();
  seedUser(repos, userId, ['staff'], []);
  const app = buildTestApp(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/platform/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 ...fx.authHeader(fx.issueTestToken({ userId, roleCodes: ['staff'] })) },
      body: JSON.stringify({ code: 'T1', name: 'Test Tenant' })
    });
    assert.equal(r.status, 403, 'staff must receive 403');
    assert.equal(r.body.error, 'platform_role_required', 'error code must be platform_role_required');
  } finally { srv.close(); }
});

// ── P3: company_admin → 403 ───────────────────────────────────────────────────

test('platform RBAC P3: POST /tenants with company_admin → 403', async () => {
  const repos  = fx.makeFakeRepos();
  const userId = crypto.randomUUID();
  seedUser(repos, userId, ['company_admin'], ['auth.user.create']);
  const app = buildTestApp(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/platform/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 ...fx.authHeader(fx.issueTestToken({ userId, roleCodes: ['company_admin'] })) },
      body: JSON.stringify({ code: 'T1', name: 'Test Tenant' })
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'platform_role_required');
  } finally { srv.close(); }
});

// ── P4: property_admin → 403 ──────────────────────────────────────────────────

test('platform RBAC P4: POST /tenants with property_admin → 403', async () => {
  const repos  = fx.makeFakeRepos();
  const userId = crypto.randomUUID();
  seedUser(repos, userId, ['property_admin'], []);
  const app = buildTestApp(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/platform/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 ...fx.authHeader(fx.issueTestToken({ userId, roleCodes: ['property_admin'] })) },
      body: JSON.stringify({ code: 'T1', name: 'Test Tenant' })
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'platform_role_required');
  } finally { srv.close(); }
});

// ── P5: corporate_admin → 403 ─────────────────────────────────────────────────

test('platform RBAC P5: POST /tenants with corporate_admin → 403', async () => {
  const repos  = fx.makeFakeRepos();
  const userId = crypto.randomUUID();
  seedUser(repos, userId, ['corporate_admin'], ['auth.user.create', 'pms.reservation.write']);
  const app = buildTestApp(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/platform/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 ...fx.authHeader(fx.issueTestToken({ userId, roleCodes: ['corporate_admin'] })) },
      body: JSON.stringify({ code: 'T1', name: 'Test Tenant' })
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'platform_role_required');
  } finally { srv.close(); }
});

// ── P6: platform_admin → 201 ──────────────────────────────────────────────────

test('platform RBAC P6: POST /tenants with platform_admin + correct permissions → 201', async () => {
  const repos  = fx.makeFakeRepos();
  const userId = crypto.randomUUID();
  seedUser(repos, userId, ['platform_admin'],
    ['tenant.provision', 'tenant.read', 'tenant.suspend', 'invitation.create.any', 'invitation.revoke.any']);
  const app = buildTestApp(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/platform/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 ...fx.authHeader(fx.issueTestToken({ userId, tenantId: PLATFORM_TENANT, roleCodes: ['platform_admin'] })) },
      body: JSON.stringify({ code: 'NEW-TENANT', name: 'New Hotel Group', ownerEmail: 'owner@hotel.test' })
    });
    assert.equal(r.status, 201, 'platform_admin must be permitted: ' + JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
  } finally { srv.close(); }
});

// ── P7: super_admin → 201 (no explicit permissions required — bypass) ─────────

test('platform RBAC P7: POST /tenants with super_admin → 201 (super_admin bypasses permission check)', async () => {
  const repos  = fx.makeFakeRepos();
  const userId = crypto.randomUUID();
  seedUser(repos, userId, ['super_admin'], []); // no explicit permissions needed
  const app = buildTestApp(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/platform/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 ...fx.authHeader(fx.issueTestToken({ userId, tenantId: PLATFORM_TENANT, roleCodes: ['super_admin'] })) },
      body: JSON.stringify({ code: 'NEW-TENANT-SA', name: 'SA Hotel Group', ownerEmail: 'sa@hotel.test' })
    });
    assert.equal(r.status, 201, 'super_admin must be permitted: ' + JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
  } finally { srv.close(); }
});

// ── P8: invitation create — corporate_admin blocked ───────────────────────────

test('platform RBAC P8: POST /tenants/:id/invitations with corporate_admin → 403', async () => {
  const repos  = fx.makeFakeRepos();
  const userId = crypto.randomUUID();
  seedUser(repos, userId, ['corporate_admin'], ['auth.user.create']);
  const app = buildTestApp(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/platform/tenants/' + fx.TENANT_A + '/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 ...fx.authHeader(fx.issueTestToken({ userId, roleCodes: ['corporate_admin'] })) },
      body: JSON.stringify({ email: 'new@hotel.test', role_codes: ['staff'], property_ids: [] })
    });
    assert.equal(r.status, 403, 'corporate_admin must be blocked from platform invitation');
    assert.equal(r.body.error, 'platform_role_required');
  } finally { srv.close(); }
});

// ── P9: invitation create — platform_admin allowed ────────────────────────────

test('platform RBAC P9: POST /tenants/:id/invitations with platform_admin → 201', async () => {
  const repos  = fx.makeFakeRepos();
  const userId = crypto.randomUUID();
  seedUser(repos, userId, ['platform_admin'], ['invitation.create.any']);
  const app = buildTestApp(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/platform/tenants/' + fx.TENANT_A + '/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 ...fx.authHeader(fx.issueTestToken({ userId, tenantId: PLATFORM_TENANT, roleCodes: ['platform_admin'] })) },
      body: JSON.stringify({ email: 'new@hotel.test', role_codes: ['staff'], property_ids: [] })
    });
    assert.equal(r.status, 201, 'platform_admin must be permitted: ' + JSON.stringify(r.body));
  } finally { srv.close(); }
});

// ── P10: invitation revoke — corporate_admin blocked ─────────────────────────

test('platform RBAC P10: PATCH /invitations/:id/revoke with corporate_admin → 403', async () => {
  const repos  = fx.makeFakeRepos();
  const userId = crypto.randomUUID();
  seedUser(repos, userId, ['corporate_admin'], ['auth.user.create']);
  const app = buildTestApp(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/platform/invitations/' + crypto.randomUUID() + '/revoke', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json',
                 ...fx.authHeader(fx.issueTestToken({ userId, roleCodes: ['corporate_admin'] })) },
      body: JSON.stringify({})
    });
    assert.equal(r.status, 403, 'corporate_admin must be blocked from revoke');
    assert.equal(r.body.error, 'platform_role_required');
  } finally { srv.close(); }
});

// ── P11: invitation revoke — super_admin allowed ──────────────────────────────

test('platform RBAC P11: PATCH /invitations/:id/revoke with super_admin → 200', async () => {
  const repos  = fx.makeFakeRepos();
  const userId = crypto.randomUUID();
  seedUser(repos, userId, ['super_admin'], []);
  const app = buildTestApp(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/platform/invitations/' + crypto.randomUUID() + '/revoke', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json',
                 ...fx.authHeader(fx.issueTestToken({ userId, tenantId: PLATFORM_TENANT, roleCodes: ['super_admin'] })) },
      body: JSON.stringify({})
    });
    assert.equal(r.status, 200, 'super_admin must be permitted: ' + JSON.stringify(r.body));
  } finally { srv.close(); }
});

// ── P12: cross-tenant manipulation blocked at role layer ──────────────────────

test('platform RBAC P12: corporate_admin cannot manipulate another tenant — blocked at role layer', async () => {
  const repos  = fx.makeFakeRepos();
  const userId = crypto.randomUUID();
  // corporate_admin from TENANT_A attempting to create invitations for TENANT_B
  seedUser(repos, userId, ['corporate_admin'], ['auth.user.create']);
  const app = buildTestApp(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/platform/tenants/' + fx.TENANT_B + '/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 ...fx.authHeader(fx.issueTestToken({ userId, roleCodes: ['corporate_admin'] })) },
      body: JSON.stringify({ email: 'victim@hotel.test', role_codes: ['staff'], property_ids: [] })
    });
    // requirePlatformRole fires before any service call; request never reaches tenantId logic
    assert.equal(r.status, 403, 'cross-tenant manipulation must be blocked');
    assert.equal(r.body.error, 'platform_role_required',
      'blocked at role layer (not permission layer) so no service call occurs');
  } finally { srv.close(); }
});
