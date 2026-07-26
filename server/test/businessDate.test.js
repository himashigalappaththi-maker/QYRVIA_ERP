'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { createApp } = require('../src/app');
const commandBus    = require('../src/core/commandBus');
const { makeEvent } = require('../src/core/event');

test('businessDate middleware populates req.ctx.businessDate from property', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedPropertyDate(fx.PROP_ID, '2026-03-15', false);
  const db = fx.makeFakeDb();
  const app = createApp({ db, identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });

  commandBus.reset();
  let observedCtx = null;
  commandBus.register({
    name: 'bizdate.capture',
    aggregateType: 'demo',
    async handler(input, ctx) {
      observedCtx = ctx;
      return { ok: true, result: {} };
    }
  });

  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({
      userId: fx.USER_ID, tenantId: fx.TENANT_A,
      primaryPropertyId: fx.PROP_ID, roleCodes: ['corporate_admin']
    });
    const r = await fx.fetchJson(url + '/api/core/commands/bizdate.capture', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({})
    });
    assert.equal(r.status, 200);
    assert.ok(observedCtx);
    assert.equal(observedCtx.businessDate, '2026-03-15');
    assert.equal(observedCtx.businessDateLocked, false);
    assert.equal(observedCtx.propertyId, fx.PROP_ID);
  } finally { srv.close(); }
});

test('businessDate defaults to today when property has no current_business_date', async () => {
  const repos = fx.makeFakeRepos();
  // No _seedPropertyDate call -> findPropertyBusinessDate returns null
  const db = fx.makeFakeDb();
  const app = createApp({ db, identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });

  commandBus.reset();
  let observedCtx = null;
  commandBus.register({
    name: 'bizdate.fallback',
    aggregateType: 'demo',
    async handler(input, ctx) { observedCtx = ctx; return { ok: true, result: {} }; }
  });

  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ tenantId: fx.TENANT_A, primaryPropertyId: fx.PROP_ID, roleCodes: ['corporate_admin'] });
    const r = await fx.fetchJson(url + '/api/core/commands/bizdate.fallback', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({})
    });
    assert.equal(r.status, 200);
    assert.equal(observedCtx.businessDate, new Date().toISOString().slice(0,10));
  } finally { srv.close(); }
});

test('businessDate is null when no property is in scope', async () => {
  const repos = fx.makeFakeRepos();
  const db = fx.makeFakeDb();
  const app = createApp({ db, identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });

  commandBus.reset();
  let observedCtx = null;
  commandBus.register({
    name: 'bizdate.tenant.only',
    aggregateType: 'demo',
    async handler(input, ctx) { observedCtx = ctx; return { ok: true, result: {} }; }
  });

  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ tenantId: fx.TENANT_A, primaryPropertyId: null, roleCodes: ['corporate_admin'] });
    const r = await fx.fetchJson(url + '/api/core/commands/bizdate.tenant.only', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({})
    });
    assert.equal(r.status, 200);
    assert.equal(observedCtx.businessDate, null);
    assert.equal(observedCtx.propertyId, null);
  } finally { srv.close(); }
});

// ---------------------------------------------------------------------------
// Phase 63 P0-9 — the business-date lookup must FAIL CLOSED.
//
// findPropertyBusinessDate returning null does not mean "new property": in
// production the SELECT always yields a row for a visible property, so null
// means the property was not visible at all (RLS blocked it, wrong tenant,
// deleted). The middleware used to treat that identically to "no date yet" and
// hand the request businessDate = today with businessDateLocked = false —
// silently defeating the night-audit financial lock and stamping folio lines
// with a fabricated business date.
// ---------------------------------------------------------------------------

test('P0-9: an unresolvable property is rejected, never defaulted to an unlocked today', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._markPropertyUnresolvable(fx.PROP_ID);
  const db = fx.makeFakeDb();
  const app = createApp({ db, identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });

  commandBus.reset();
  let handlerRan = false;
  commandBus.register({
    name: 'bizdate.failclosed',
    aggregateType: 'demo',
    async handler() { handlerRan = true; return { ok: true, result: {} }; }
  });

  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ tenantId: fx.TENANT_A, primaryPropertyId: fx.PROP_ID, roleCodes: ['corporate_admin'] });
    const r = await fx.fetchJson(url + '/api/core/commands/bizdate.failclosed', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({})
    });
    assert.equal(r.status, 409, 'the request must be refused, not silently defaulted');
    assert.equal(r.body.error, 'property_business_date_unresolved');
    assert.equal(handlerRan, false, 'no command may run without a proven business date');
  } finally { srv.close(); }
});

test('P0-9: a property that exists but was never night-audited still gets its REAL lock flag', async () => {
  const repos = fx.makeFakeRepos();
  // Seeded with a date AND locked=true — the lock must survive to the command ctx.
  repos.identityRepo._seedPropertyDate(fx.PROP_ID, '2026-03-15', true);
  const db = fx.makeFakeDb();
  const app = createApp({ db, identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });

  commandBus.reset();
  let observedCtx = null;
  commandBus.register({
    name: 'bizdate.locked.capture',
    aggregateType: 'demo',
    async handler(input, ctx) { observedCtx = ctx; return { ok: true, result: {} }; }
  });

  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ tenantId: fx.TENANT_A, primaryPropertyId: fx.PROP_ID, roleCodes: ['corporate_admin'] });
    const r = await fx.fetchJson(url + '/api/core/commands/bizdate.locked.capture', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({})
    });
    assert.equal(r.status, 200);
    assert.equal(observedCtx.businessDateLocked, true, 'the night-audit lock must reach the command bus');
  } finally { srv.close(); }
});
