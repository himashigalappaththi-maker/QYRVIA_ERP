'use strict';

/** Phase 31.5 - API property authorization: X-Property-Id override must be assigned (fail-closed). */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identityContext } = require('../src/middleware/identityContext');

const PRIMARY = '11111111-1111-4111-8111-111111111111';
const ASSIGNED = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333';

function run(headerProperty, repo) {
  const req = {
    requestId: 'rq', user: { sub: 'u1', tenant_id: 'T1', primary_property_id: PRIMARY, role_codes: ['STAFF'] },
    get: (h) => (h === 'x-property-id' ? headerProperty : undefined)
  };
  let status = 200, body = null, nexted = false;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  return identityContext(repo)(req, res, () => { nexted = true; }).then(() => ({ status, body, nexted, ctx: req.ctx }));
}

const repo = {
  async findPermissionsForUser() { return []; },
  async canAccessProperty(_u, pid) { return pid === ASSIGNED || pid === PRIMARY; }
};

test('X-Property-Id to an UNASSIGNED property -> 403 property_access_denied', async () => {
  const r = await run(FOREIGN, repo);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'property_access_denied');
  assert.equal(r.nexted, false);
});

test('X-Property-Id to an ASSIGNED property -> allowed, ctx scoped to it', async () => {
  const r = await run(ASSIGNED, repo);
  assert.equal(r.nexted, true);
  assert.equal(r.ctx.propertyId, ASSIGNED);
});

test('X-Property-Id equal to the primary property -> allowed (no extra check needed)', async () => {
  const r = await run(PRIMARY, repo);
  assert.equal(r.nexted, true);
  assert.equal(r.ctx.propertyId, PRIMARY);
});

test('malformed X-Property-Id -> 400 x_property_id_invalid', async () => {
  const r = await run('not-a-uuid', repo);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'x_property_id_invalid');
});

test('repo failure on the access check -> 500 (fail-closed, not allowed through)', async () => {
  const r = await run(ASSIGNED, { async findPermissionsForUser() { return []; }, async canAccessProperty() { throw new Error('db down'); } });
  assert.equal(r.status, 500);
  assert.equal(r.nexted, false);
});
