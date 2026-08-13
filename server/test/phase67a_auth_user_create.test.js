'use strict';

/**
 * Phase 67A Workstream E — commands/auth.user.create.js contract tests.
 *
 * Covers email normalization and primary_property_id validation. Pure unit
 * tests against an in-memory repo — no PostgreSQL connection.
 */

const { test } = require('node:test');
const assert    = require('node:assert/strict');

const authUserCreate = require('../src/commands/auth.user.create');

const TENANT_A = 'aaaaaaaa-aaaa-1aaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-1bbb-bbbb-bbbbbbbbbbbb';
const PROP_1   = 'p1111111-1111-1111-1111-111111111111';
const PROP_2   = 'p2222222-2222-2222-2222-222222222222';

function makeRepo() {
  const usersByUsername = new Map();
  const usersByEmail    = new Map(); // exact (already-normalized) email -> true
  const properties      = new Map();
  const accessGrants    = new Set();
  const inserted        = [];
  const roleGrants      = [];

  return {
    _seedProperty(p) { properties.set(p.id, p); },
    _grantAccess(actorId, propertyId) { accessGrants.add(actorId + '|' + propertyId); },
    _takeUsername(tenantId, username) { usersByUsername.set(tenantId + '|' + username, true); },
    _takeEmail(email) { usersByEmail.set(email, true); },
    _inserted: inserted,
    _roleGrants: roleGrants,

    // Presence-only gate the handler checks before calling ...ById.
    async findUserByTenantUsername() { return null; },
    async findUserByTenantUsernameById(tenantId, username) {
      return usersByUsername.get(tenantId + '|' + username) ? { id: 'existing' } : null;
    },
    async withTenant(tenantId, cb) { return cb({ tenantId }); },
    async findPropertyForAuth(id) { return properties.get(id) || null; },
    async canAccessProperty(actorId, propertyId) { return accessGrants.has(actorId + '|' + propertyId); },
    async insertUser(rec) {
      // Mirrors the real global `uq_users_email_global` unique index
      // (migration 0071) on lower(email) — the command normalizes email to
      // trim().toLowerCase() BEFORE this call, so any case/whitespace
      // variant of an already-taken address collides here identically.
      if (rec.email && usersByEmail.has(rec.email)) {
        const err = new Error('duplicate key value violates unique constraint "uq_users_email_global"');
        err.code = '23505';
        throw err;
      }
      if (rec.email) usersByEmail.set(rec.email, true);
      const row = Object.assign({ id: 'u_' + (inserted.length + 1) }, rec);
      inserted.push(row);
      return row;
    },
    async insertUserRoleByCode(rec) { roleGrants.push(rec); }
  };
}

function ctx(overrides) {
  return Object.assign({ actorId: 'admin-1', tenantId: TENANT_A, roleCodes: ['corporate_admin'], requestId: 'req-1' }, overrides);
}

function baseInput(overrides) {
  return Object.assign({
    username: 'jdoe', password: 'Secret123', full_name: 'Jane Doe'
  }, overrides);
}

function setup() {
  const repo = makeRepo();
  authUserCreate.setRepo(repo);
  return repo;
}

// ── Email normalization ──────────────────────────────────────────────────────

test('auth.user.create: MixedCase@Example.com is normalized and stored as mixedcase@example.com', async () => {
  const repo = setup();
  const r = await authUserCreate.handler(baseInput({ email: 'MixedCase@Example.com' }), ctx());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(repo._inserted[0].email, 'mixedcase@example.com');
  assert.equal(r.events[0].payload.email, 'mixedcase@example.com');
});

test('auth.user.create: surrounding whitespace in the email is trimmed', async () => {
  const repo = setup();
  const r = await authUserCreate.handler(baseInput({ email: '  owner@acme.com  ' }), ctx());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(repo._inserted[0].email, 'owner@acme.com');
});

test('auth.user.create: null email is left null (email is optional)', async () => {
  const repo = setup();
  const r = await authUserCreate.handler(baseInput({}), ctx());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(repo._inserted[0].email, null);
});

test('auth.user.create: a case-variant of an already-registered email collides at the persistence boundary', async () => {
  const repo = setup();
  repo._takeEmail('owner@acme.com'); // already registered, in normalized form
  await assert.rejects(
    () => authUserCreate.handler(baseInput({ username: 'jdoe2', email: 'Owner@ACME.com' }), ctx()),
    (err) => err.code === '23505'
  );
});

test('auth.user.create: a whitespace-variant of an already-registered email collides at the persistence boundary', async () => {
  const repo = setup();
  repo._takeEmail('owner@acme.com');
  await assert.rejects(
    () => authUserCreate.handler(baseInput({ username: 'jdoe3', email: '  owner@acme.com ' }), ctx()),
    (err) => err.code === '23505'
  );
});

// ── primary_property_id validation ──────────────────────────────────────────

test('auth.user.create: primary_property_id from another tenant is rejected', async () => {
  const repo = setup();
  repo._seedProperty({ id: PROP_1, tenant_id: TENANT_B }); // belongs to a DIFFERENT tenant
  repo._grantAccess('admin-1', PROP_1);
  const r = await authUserCreate.handler(baseInput({ primary_property_id: PROP_1 }), ctx({ tenantId: TENANT_A }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'cross_tenant_property_assignment');
});

test('auth.user.create: primary_property_id the caller cannot themselves access is rejected', async () => {
  const repo = setup();
  repo._seedProperty({ id: PROP_1, tenant_id: TENANT_A });
  // Deliberately do NOT grant admin-1 access to PROP_1.
  const r = await authUserCreate.handler(baseInput({ primary_property_id: PROP_1 }), ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unauthorized_property_assignment');
});

test('auth.user.create: a nonexistent primary_property_id is rejected', async () => {
  setup();
  const r = await authUserCreate.handler(baseInput({ primary_property_id: 'does-not-exist' }), ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'property_not_found');
});

test('auth.user.create: a valid, authorized primary_property_id succeeds', async () => {
  const repo = setup();
  repo._seedProperty({ id: PROP_1, tenant_id: TENANT_A });
  repo._grantAccess('admin-1', PROP_1);
  const r = await authUserCreate.handler(baseInput({ primary_property_id: PROP_1 }), ctx());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(repo._inserted[0].primary_property_id, PROP_1);
  assert.equal(repo._roleGrants[0].property_id, PROP_1);
});

test('auth.user.create: omitting primary_property_id entirely skips property validation and succeeds', async () => {
  const repo = setup();
  const r = await authUserCreate.handler(baseInput({}), ctx());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(repo._inserted[0].primary_property_id, null);
});

// ── Phase 67A-003 Workstream E: single tenant-scoped transaction, rollback ──
//
// These tests prove auth.user.create.js PROPAGATES a mid-transaction
// failure (never swallows it into a false "success") and never performs a
// LATER step after an earlier one has failed. TRUE atomicity — that a
// thrown error actually rolls back a real database transaction — is
// enforced by db/client.js's withTenant (outside this phase's permitted
// file scope; independently documented as rolling back and rethrowing on
// any callback exception). This mock's withTenant is a plain passthrough
// with no real transactional state, so what these tests can and do prove
// is: the failure is never caught/hidden, and no step after the failing
// one executes — which is exactly what determines whether db/client.js's
// real rollback gets triggered correctly.

test('auth.user.create: user insertion failure propagates (rejects) and no role grant is ever attempted', async () => {
  const repo = setup();
  repo.insertUser = async () => { throw new Error('insert failed'); };
  const r = await new Promise((resolve) => {
    authUserCreate.handler(baseInput({}), ctx()).then(
      (v) => resolve({ resolved: true, v }),
      (e) => resolve({ resolved: false, e })
    );
  });
  assert.equal(r.resolved, false, 'a user-insertion failure must reject, not resolve as {ok:false}');
  assert.match(r.e.message, /insert failed/);
  assert.equal(repo._roleGrants.length, 0, 'no role grant may be attempted after user insertion fails');
});

test('auth.user.create: role-assignment failure propagates (rejects) — the transaction is never allowed to "partially succeed"', async () => {
  const repo = setup();
  repo.insertUserRoleByCode = async () => { throw new Error('role grant failed'); };
  const r = await new Promise((resolve) => {
    authUserCreate.handler(baseInput({}), ctx()).then(
      (v) => resolve({ resolved: true, v }),
      (e) => resolve({ resolved: false, e })
    );
  });
  assert.equal(r.resolved, false, 'a role-assignment failure must reject the whole call, not return ok:true with an orphaned user');
  assert.match(r.e.message, /role grant failed/);
});

test('auth.user.create: role-assignment failure on the SECOND of two requested roles stops after the failing one (no third step runs)', async () => {
  const repo = setup();
  let calls = 0;
  repo.insertUserRoleByCode = async (rec) => {
    calls += 1;
    if (calls === 2) throw new Error('second role grant failed');
    repo._roleGrants.push(rec);
  };
  await assert.rejects(() => authUserCreate.handler(baseInput({ role_codes: ['staff', 'front_office_manager'] }), ctx()),
    /second role grant failed/);
  assert.equal(calls, 2, 'must stop at the failing role grant, not continue past it');
});

test('auth.user.create: still succeeds end-to-end when nothing fails (control case for the rollback tests above)', async () => {
  const repo = setup();
  const r = await authUserCreate.handler(baseInput({}), ctx());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(repo._inserted.length, 1);
  assert.equal(repo._roleGrants.length, 1);
});

test('auth.user.create: a caller holding a tenant-wide grant can assign any in-tenant property (canAccessProperty enforces this, not this test)', async () => {
  // Sanity control: PROP_2 is in-tenant and access IS granted -> succeeds,
  // proving the two rejection tests above are about the specific denial
  // condition and not some unrelated validation failure.
  const repo = setup();
  repo._seedProperty({ id: PROP_2, tenant_id: TENANT_A });
  repo._grantAccess('admin-1', PROP_2);
  const r = await authUserCreate.handler(baseInput({ primary_property_id: PROP_2 }), ctx());
  assert.equal(r.ok, true, JSON.stringify(r));
});
