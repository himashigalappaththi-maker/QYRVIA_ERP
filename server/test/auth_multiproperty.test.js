'use strict';

/**
 * Phase 6 - Multi-Property Auth tests (C1, C2, C3).
 */

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');
const identity      = require('../src/services/identity');

const PROP_A = 'dddddddd-dddd-1ddd-dddd-dddddddddddd';
const PROP_B = 'eeeeeeee-eeee-1eee-eeee-eeeeeeeeeeee';

async function seededRepos({ multiProperty = true } = {}) {
  const repos = fx.makeFakeRepos();
  const passwordHash = await identity.hashPassword('Secret123');
  repos.identityRepo._seedUser(
    {
      id: fx.USER_ID, tenant_id: fx.TENANT_A, tenant_code: 'TENANT-A',
      username: 'jane.doe', email: 'jane@example.com',
      password_hash: passwordHash, full_name: 'Jane Doe',
      primary_property_id: PROP_A, status: 'ACTIVE',
      accessible_property_codes: ['PROP-A', 'PROP-B']
    },
    [
      { id: 'role-fo_manager_a', code: 'front_office_manager', scope: 'PROPERTY', property_id: PROP_A },
      { id: 'role-fo_manager_b', code: 'front_office_manager', scope: 'PROPERTY', property_id: multiProperty ? PROP_B : PROP_A }
    ],
    ['pms.reservation.read']
  );
  repos.identityRepo._seedAccessibleProperty({ id: PROP_A, code: 'PROP-A', name: 'Property A', tenant_id: fx.TENANT_A, active: true });
  if (multiProperty) repos.identityRepo._seedAccessibleProperty({ id: PROP_B, code: 'PROP-B', name: 'Property B', tenant_id: fx.TENANT_A, active: true });
  return repos;
}

function appWith(repos, db) {
  return createApp({
    db: db || fx.makeFakeDb(),
    identityRepo: repos.identityRepo,
    tokensRepo: repos.tokensRepo,
    eventBus: require('../src/core/eventBus'),
    makeAuthEvent: require('../src/core/event').makeEvent && function (type, payload, req, user) {
      const { makeEvent } = require('../src/core/event');
      return makeEvent({
        type, aggregateType: 'auth',
        aggregateId: (user && user.id) || (req.user && req.user.sub) || 'anonymous',
        payload: payload || {},
        ctx: {
          tenantId:   (user && user.tenant_id) || (req.user && req.user.tenant_id) || fx.TENANT_A,
          propertyId: (user && user.primary_property_id) || null,
          actorId:    (user && user.id) || (req.user && req.user.sub) || null,
          requestId:  req.requestId
        }
      });
    }
  });
}

test('C3: login with property_code resolves user via property -> tenant chain', async () => {
  const repos = await seededRepos();
  const db = fx.makeFakeDb();
  require('../src/core/eventBus').reset();
  require('../src/core/eventBus').init({ db });
  const app = appWith(repos, db);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ property_code: 'PROP-A', username: 'jane.doe', password: 'Secret123' })
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.primary_property_id, PROP_A);
    const ev = db.auditRows.find(x => x.event_type === 'auth.login_succeeded');
    assert.equal(ev.payload.login_via, 'property_code');
  } finally { srv.close(); }
});

test('C3: login rejects both tenant_code AND property_code', async () => {
  const repos = await seededRepos();
  const app = appWith(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_code: 'TENANT-A', property_code: 'PROP-A', username: 'jane.doe', password: 'Secret123' })
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_login_identifiers');
  } finally { srv.close(); }
});

test('C3: login rejects neither tenant_code NOR property_code', async () => {
  const repos = await seededRepos();
  const app = appWith(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'jane.doe', password: 'Secret123' })
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_login_identifiers');
  } finally { srv.close(); }
});

test('BC: legacy tenant_code login still works + audit carries login_via=tenant_code', async () => {
  const repos = await seededRepos();
  const db = fx.makeFakeDb();
  require('../src/core/eventBus').reset();
  require('../src/core/eventBus').init({ db });
  const app = appWith(repos, db);
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_code: 'TENANT-A', username: 'jane.doe', password: 'Secret123' })
    });
    assert.equal(r.status, 200);
    const ev = db.auditRows.find(x => x.event_type === 'auth.login_succeeded');
    assert.equal(ev.payload.login_via, 'tenant_code');
  } finally { srv.close(); }
});

test('C2: GET /api/auth/properties returns properties the user holds a role at', async () => {
  const repos = await seededRepos();
  const app = appWith(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: fx.USER_ID, roleCodes: ['front_office_manager'], primaryPropertyId: PROP_A });
    const r = await fx.fetchJson(url + '/api/auth/properties', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    const codes = r.body.data.map(p => p.code).sort();
    assert.deepEqual(codes, ['PROP-A', 'PROP-B']);
  } finally { srv.close(); }
});

test('C2: GET /api/auth/properties returns only the single property when no other access', async () => {
  const repos = await seededRepos({ multiProperty: false });
  const app = appWith(repos);
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: fx.USER_ID, roleCodes: ['front_office_manager'], primaryPropertyId: PROP_A });
    const r = await fx.fetchJson(url + '/api/auth/properties', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.length, 1);
    assert.equal(r.body.data[0].code, 'PROP-A');
  } finally { srv.close(); }
});

test('C1: POST /api/auth/switch-property issues a new JWT scoped to target', async () => {
  const repos = await seededRepos();
  const db = fx.makeFakeDb();
  require('../src/core/eventBus').reset();
  require('../src/core/eventBus').init({ db });
  const app = appWith(repos, db);
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: fx.USER_ID, roleCodes: ['front_office_manager'], primaryPropertyId: PROP_A });
    const r = await fx.fetchJson(url + '/api/auth/switch-property', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ property_id: PROP_B })
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.property_id, PROP_B);
    assert.ok(r.body.access_token);
    const ev = db.auditRows.find(x => x.event_type === 'auth.property_switched');
    assert.equal(ev.payload.to_property_id, PROP_B);
    assert.equal(ev.payload.from_property_id, PROP_A);
  } finally { srv.close(); }
});

test('C1: POST /api/auth/switch-property rejects target the user has no role at', async () => {
  const repos = await seededRepos({ multiProperty: false });   // user only has PROP_A
  const db = fx.makeFakeDb();
  require('../src/core/eventBus').reset();
  require('../src/core/eventBus').init({ db });
  const app = appWith(repos, db);
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: fx.USER_ID, roleCodes: ['front_office_manager'], primaryPropertyId: PROP_A });
    const r = await fx.fetchJson(url + '/api/auth/switch-property', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ property_id: PROP_B })
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'not_authorized_at_property');
    const denied = db.auditRows.find(x => x.event_type === 'auth.property_switch_denied');
    assert.ok(denied, 'expected property_switch_denied event');
  } finally { srv.close(); }
});
