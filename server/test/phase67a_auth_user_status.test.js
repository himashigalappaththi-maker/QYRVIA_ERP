'use strict';

/**
 * Phase 67A Workstream C — commands/auth.user.status.js contract tests.
 *
 * Pure unit tests against an in-memory repo (no PostgreSQL connection, no
 * db/client.js, no db/tenantUnitOfWork.js). Exercises every denial branch
 * documented in the command's own doc comment plus the happy path.
 */

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const crypto    = require('node:crypto');

const authUserStatus = require('../src/commands/auth.user.status');

const TENANT_A = 'aaaaaaaa-aaaa-1aaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-1bbb-bbbb-bbbbbbbbbbbb';
const PROP_1   = 'p1111111-1111-1111-1111-111111111111';
const PROP_2   = 'p2222222-2222-2222-2222-222222222222';

function makeRepo() {
  const users = new Map();       // id -> { id, tenant_id, status, primary_property_id }
  const roles = new Map();       // userId -> [{ code, property_id }]
  const revokedFor = [];
  const statusWrites = [];

  return {
    _seedUser(u) { users.set(u.id, Object.assign({ status: 'ACTIVE' }, u)); },
    _seedRoles(userId, r) { roles.set(userId, r); },
    _revokedFor: revokedFor,
    _statusWrites: statusWrites,

    async withTenant(tenantId, cb) {
      const client = { tenantId };
      return cb(client);
    },
    async findUserById(id, client) {
      const u = users.get(id);
      if (!u) return null;
      // Tenant-scoped by construction: invisible on a connection bound to a
      // different tenant, mirroring FORCE RLS.
      if (u.tenant_id !== client.tenantId) return null;
      return u;
    },
    async findRolesForUser(userId) { return roles.get(userId) || []; },
    async updateUserStatus(userId, status, tenantId) {
      statusWrites.push({ userId, status, tenantId });
      const u = users.get(userId);
      if (u) u.status = status;
    },
    async revokeAllRefreshTokensForUser(userId) { revokedFor.push(userId); }
  };
}

function ctx(overrides) {
  return Object.assign({ actorId: 'admin-1', tenantId: TENANT_A, propertyId: null, requestId: 'req-1' }, overrides);
}

function setup() {
  const repo = makeRepo();
  authUserStatus.setRepo(repo);
  return repo;
}

// ── Happy path ──────────────────────────────────────────────────────────────

test('auth.user.status.change: authorized tenant-wide admin can DISABLE a target user', async () => {
  const repo = setup();
  repo._seedUser({ id: 'u1', tenant_id: TENANT_A, status: 'ACTIVE' });
  repo._seedRoles('admin-1', [{ code: 'corporate_admin', property_id: null }]); // tenant-wide caller
  repo._seedRoles('u1', [{ code: 'staff', property_id: PROP_1 }]);

  const r = await authUserStatus.handler({ target_user_id: 'u1', status: 'DISABLED' }, ctx());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.previous_status, 'ACTIVE');
  assert.equal(r.result.status, 'DISABLED');
});

test('auth.user.status.change: authorized admin can TERMINATE a target user', async () => {
  const repo = setup();
  repo._seedUser({ id: 'u1', tenant_id: TENANT_A, status: 'ACTIVE' });
  repo._seedRoles('admin-1', [{ code: 'corporate_admin', property_id: null }]);
  repo._seedRoles('u1', [{ code: 'staff', property_id: PROP_1 }]);

  const r = await authUserStatus.handler({ target_user_id: 'u1', status: 'TERMINATED' }, ctx());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.status, 'TERMINATED');
});

// ── Arbitrary / invalid status ──────────────────────────────────────────────

test('auth.user.status.change: an arbitrary status string is rejected', async () => {
  const repo = setup();
  repo._seedUser({ id: 'u1', tenant_id: TENANT_A, status: 'ACTIVE' });
  const r = await authUserStatus.handler({ target_user_id: 'u1', status: 'DELETED' }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_status');
});

test('auth.user.status.change: ACTIVE/LOCKED/PENDING_PASSWORD_RESET are rejected (only DISABLED/TERMINATED allowed)', async () => {
  const repo = setup();
  repo._seedUser({ id: 'u1', tenant_id: TENANT_A, status: 'ACTIVE' });
  for (const bad of ['ACTIVE', 'LOCKED', 'PENDING_PASSWORD_RESET']) {
    const r = await authUserStatus.handler({ target_user_id: 'u1', status: bad }, ctx());
    assert.equal(r.ok, false, `status ${bad} should be rejected`);
    assert.equal(r.error, 'invalid_status');
  }
});

test('auth.user.status.change: missing target_user_id is rejected', async () => {
  setup();
  const r = await authUserStatus.handler({ status: 'DISABLED' }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'target_required');
});

// ── Cross-tenant target ─────────────────────────────────────────────────────

test('auth.user.status.change: a target belonging to a different tenant is treated as not found', async () => {
  const repo = setup();
  repo._seedUser({ id: 'u1', tenant_id: TENANT_B, status: 'ACTIVE' }); // different tenant
  repo._seedRoles('admin-1', [{ code: 'corporate_admin', property_id: null }]);

  const r = await authUserStatus.handler({ target_user_id: 'u1', status: 'DISABLED' }, ctx({ tenantId: TENANT_A }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'target_not_found');
});

// ── Property-scoped caller ──────────────────────────────────────────────────

test('auth.user.status.change: a property-scoped caller cannot alter a user outside their property', async () => {
  const repo = setup();
  repo._seedUser({ id: 'u1', tenant_id: TENANT_A, status: 'ACTIVE', primary_property_id: PROP_2 });
  // Caller holds ONLY a property-scoped grant for PROP_1 — not tenant-wide.
  repo._seedRoles('admin-1', [{ code: 'property_admin', property_id: PROP_1 }]);
  repo._seedRoles('u1', [{ code: 'staff', property_id: PROP_2 }]);

  const r = await authUserStatus.handler({ target_user_id: 'u1', status: 'DISABLED' },
    ctx({ propertyId: PROP_1 }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unauthorized_property_target');
});

test('auth.user.status.change: a property-scoped caller CAN alter a user within their own property', async () => {
  const repo = setup();
  repo._seedUser({ id: 'u1', tenant_id: TENANT_A, status: 'ACTIVE', primary_property_id: PROP_1 });
  repo._seedRoles('admin-1', [{ code: 'property_admin', property_id: PROP_1 }]);
  repo._seedRoles('u1', [{ code: 'staff', property_id: PROP_1 }]);

  const r = await authUserStatus.handler({ target_user_id: 'u1', status: 'DISABLED' },
    ctx({ propertyId: PROP_1 }));
  assert.equal(r.ok, true, JSON.stringify(r));
});

// ── System-role / final-active-Super-Admin protection ───────────────────────

test('auth.user.status.change: a customer (tenant-wide) admin cannot alter a super_admin target', async () => {
  const repo = setup();
  repo._seedUser({ id: 'u1', tenant_id: TENANT_A, status: 'ACTIVE' });
  repo._seedRoles('admin-1', [{ code: 'corporate_admin', property_id: null }]);
  repo._seedRoles('u1', [{ code: 'super_admin', property_id: null }]);

  const r = await authUserStatus.handler({ target_user_id: 'u1', status: 'DISABLED' }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'protected_system_role');
});

test('auth.user.status.change: protection is unconditional — even a super_admin caller cannot alter a platform_admin target', async () => {
  // This is the "final active Super Admin" escape-hatch behaviour: the
  // command has no RLS-safe way to count active super_admins platform-wide,
  // so it blocks ALL protected-role targets regardless of caller identity.
  const repo = setup();
  repo._seedUser({ id: 'u1', tenant_id: TENANT_A, status: 'ACTIVE' });
  repo._seedRoles('admin-1', [{ code: 'super_admin', property_id: null }]);
  repo._seedRoles('u1', [{ code: 'platform_admin', property_id: null }]);

  const r = await authUserStatus.handler({ target_user_id: 'u1', status: 'TERMINATED' }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'protected_system_role');
});

// ── Self-status-change ───────────────────────────────────────────────────────

test('auth.user.status.change: an admin cannot disable/terminate their own account', async () => {
  const repo = setup();
  repo._seedUser({ id: 'admin-1', tenant_id: TENANT_A, status: 'ACTIVE' });
  repo._seedRoles('admin-1', [{ code: 'corporate_admin', property_id: null }]);

  const r = await authUserStatus.handler({ target_user_id: 'admin-1', status: 'DISABLED' }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'self_status_change_denied');
});

// ── Already in requested status ─────────────────────────────────────────────

test('auth.user.status.change: already-DISABLED target returns already_in_requested_status', async () => {
  const repo = setup();
  repo._seedUser({ id: 'u1', tenant_id: TENANT_A, status: 'DISABLED' });
  repo._seedRoles('admin-1', [{ code: 'corporate_admin', property_id: null }]);
  repo._seedRoles('u1', [{ code: 'staff', property_id: null }]);

  const r = await authUserStatus.handler({ target_user_id: 'u1', status: 'DISABLED' }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'already_in_requested_status');
});

// ── Refresh-token revocation (session invalidation) ─────────────────────────

test('auth.user.status.change: all refresh tokens for the target are revoked on success', async () => {
  const repo = setup();
  repo._seedUser({ id: 'u1', tenant_id: TENANT_A, status: 'ACTIVE' });
  repo._seedRoles('admin-1', [{ code: 'corporate_admin', property_id: null }]);
  repo._seedRoles('u1', [{ code: 'staff', property_id: null }]);

  const r = await authUserStatus.handler({ target_user_id: 'u1', status: 'TERMINATED' }, ctx());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(repo._revokedFor, ['u1']);
  // Phase 67A-003: tenantId is now passed explicitly as a scoping
  // predicate, not relied on solely via the withTenant/FORCE RLS binding.
  assert.deepEqual(repo._statusWrites, [{ userId: 'u1', status: 'TERMINATED', tenantId: TENANT_A }]);
});

test('auth.user.status.change: refresh tokens are NOT revoked when the command is denied', async () => {
  const repo = setup();
  repo._seedUser({ id: 'u1', tenant_id: TENANT_A, status: 'ACTIVE' });
  repo._seedRoles('admin-1', [{ code: 'corporate_admin', property_id: null }]);
  repo._seedRoles('u1', [{ code: 'super_admin', property_id: null }]); // protected -> denied

  const r = await authUserStatus.handler({ target_user_id: 'u1', status: 'DISABLED' }, ctx());
  assert.equal(r.ok, false);
  assert.deepEqual(repo._revokedFor, []);
});

// ── Audit / domain event ─────────────────────────────────────────────────────

test('auth.user.status.change: a user.status_changed domain event is emitted with the expected payload', async () => {
  const repo = setup();
  repo._seedUser({ id: 'u1', tenant_id: TENANT_A, status: 'ACTIVE' });
  repo._seedRoles('admin-1', [{ code: 'corporate_admin', property_id: null }]);
  repo._seedRoles('u1', [{ code: 'staff', property_id: null }]);

  const r = await authUserStatus.handler(
    { target_user_id: 'u1', status: 'DISABLED', reason: 'policy violation' },
    ctx({ requestId: 'req-42' })
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.events.length, 1);
  const ev = r.events[0];
  assert.equal(ev.event_type, 'user.status_changed');
  assert.equal(ev.aggregate_type, 'user');
  assert.equal(ev.aggregate_id, 'u1');
  assert.equal(ev.tenant_id, TENANT_A);
  assert.equal(ev.request_id, 'req-42');
  assert.equal(ev.payload.target_user_id, 'u1');
  assert.equal(ev.payload.previous_status, 'ACTIVE');
  assert.equal(ev.payload.new_status, 'DISABLED');
  assert.equal(ev.payload.reason, 'policy violation');
  assert.equal(ev.payload.refresh_tokens_revoked, true);
});

// ── Repo not wired ────────────────────────────────────────────────────────────

test('auth.user.status.change: returns repo_not_wired when no repo has been set', async () => {
  authUserStatus.setRepo(null);
  const r = await authUserStatus.handler({ target_user_id: 'u1', status: 'DISABLED' }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'repo_not_wired');
});
