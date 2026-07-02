'use strict';

/** Phase 31.5 - multi-property access rules, property context, isolation (no DB). */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPropertyAccessEngine } = require('../src/platform/iam/PropertyAccessEngine');
const { buildContext, switchProperty, auditEnvelope, jobContext } = require('../src/platform/iam/PropertyContext');

const E = buildPropertyAccessEngine();
const ALL = ['P1', 'P2', 'P3', 'P4'];
const world = { allProperties: ALL, groups: { north: ['P1', 'P2'], south: ['P3', 'P4'] } };
const ids = (p) => E.accessiblePropertyIds(p, world).sort();

// ---- 1. Property access rules (role-driven) --------------------------------
test('COMPANY_ADMIN accesses all company properties', () => {
  assert.deepEqual(ids({ assignments: [{ role: 'COMPANY_ADMIN' }] }), ['P1', 'P2', 'P3', 'P4']);
});
test('PROPERTY_ADMIN accesses only its assigned property', () => {
  assert.deepEqual(ids({ assignments: [{ role: 'PROPERTY_ADMIN', propertyId: 'P2' }] }), ['P2']);
});
test('DEPARTMENT_HEAD accesses a configurable set of properties', () => {
  assert.deepEqual(ids({ assignments: [
    { role: 'DEPARTMENT_HEAD', propertyId: 'P1' }, { role: 'DEPARTMENT_HEAD', propertyId: 'P3' }] }), ['P1', 'P3']);
});
test('STAFF accesses only assigned property and is read-only', () => {
  const p = { assignments: [{ role: 'STAFF', propertyId: 'P4' }] };
  assert.deepEqual(ids(p), ['P4']);
  assert.equal(E.canWrite(p, world, 'P4'), false);
  assert.equal(E.canAccess(p, world, 'P4'), true);
});
test('CORPORATE_FINANCE has consolidated READ-ONLY visibility across all properties', () => {
  const p = { assignments: [{ role: 'CORPORATE_FINANCE' }] };
  assert.deepEqual(ids(p), ['P1', 'P2', 'P3', 'P4']);
  assert.equal(E.canConsolidate(p, world), true);
  assert.equal(E.canWrite(p, world, 'P1'), false);   // read-only
});
test('CORPORATE_PROCUREMENT can purchase cross-property (write all)', () => {
  const p = { assignments: [{ role: 'CORPORATE_PROCUREMENT' }] };
  assert.deepEqual(ids(p), ['P1', 'P2', 'P3', 'P4']);
  assert.equal(E.canCrossPropertyPurchase(p, world), true);
  assert.equal(E.canWrite(p, world, 'P3'), true);
});
test('REGIONAL_MANAGER accesses configurable property groups', () => {
  const p = { assignments: [{ role: 'REGIONAL_MANAGER', groupId: 'north' }] };
  assert.deepEqual(ids(p), ['P1', 'P2']);
  assert.equal(E.canAccess(p, world, 'P3'), false);   // south not in region
});
test('unknown role grants nothing (deny by default)', () => {
  assert.deepEqual(ids({ assignments: [{ role: 'WHATEVER', propertyId: 'P1' }] }), []);
});

// ---- 4. Data isolation -----------------------------------------------------
test('users cannot access unassigned properties', () => {
  const staff = { assignments: [{ role: 'STAFF', propertyId: 'P1' }] };
  assert.equal(E.canAccess(staff, world, 'P2'), false);
  assert.equal(E.canAccess(staff, world, 'P1'), true);
});

test('property switch to an unassigned property is rejected; switch to assigned yields a NEW immutable context', () => {
  const acc = E.accessiblePropertyIds({ assignments: [{ role: 'DEPARTMENT_HEAD', propertyId: 'P1' }, { role: 'DEPARTMENT_HEAD', propertyId: 'P2' }] }, world);
  const ctx = buildContext({ tenantId: 'T1', userId: 'U1', propertyId: 'P1' });
  assert.throws(() => switchProperty(ctx, 'P3', acc), /property_access_denied/);
  const ctx2 = switchProperty(ctx, 'P2', acc);
  assert.equal(ctx.propertyId, 'P1', 'original context not mutated (no leak)');
  assert.equal(ctx2.propertyId, 'P2');
  assert.notEqual(ctx.requestId, ctx2.requestId, 'fresh requestId on switch (no stale data rides along)');
  assert.ok(Object.isFrozen(ctx2));
});

test('property switching never leaks: 200 concurrent switches keep independent contexts', async () => {
  const acc = ['P1', 'P2', 'P3', 'P4'];
  const base = buildContext({ tenantId: 'T1', userId: 'U1', propertyId: 'P1' });
  const results = await Promise.all(Array.from({ length: 200 }, (_, i) => {
    const target = acc[i % 4];
    return Promise.resolve(switchProperty(base, target, acc)).then((c) => c.propertyId === target);
  }));
  assert.ok(results.every(Boolean), 'every switched context kept its own property');
  assert.equal(base.propertyId, 'P1', 'base context never mutated under concurrency');
});

// ---- 2. Property context & audit envelope ----------------------------------
test('audit envelope requires tenant_id, property_id, user_id, timestamp - no exceptions', () => {
  const env = auditEnvelope(buildContext({ tenantId: 'T1', userId: 'U1', propertyId: 'P1' }), { action: 'x' });
  for (const k of ['tenant_id', 'property_id', 'user_id', 'occurred_at']) assert.ok(env[k], 'missing ' + k);
  assert.throws(() => auditEnvelope(buildContext({ tenantId: 'T1', userId: 'U1' })), /propertyId required/);
});

// ---- 4. Background/scheduled jobs use explicit property context ------------
test('background job context requires an EXPLICIT property (cannot inherit previous state)', () => {
  assert.throws(() => jobContext({ tenantId: 'T1', jobName: 'nightaudit' }), /explicit propertyId is required/);
  const jc = jobContext({ tenantId: 'T1', propertyId: 'P2', jobName: 'nightaudit' });
  assert.equal(jc.propertyId, 'P2');
  assert.ok(auditEnvelope(jc).property_id === 'P2');
});

// ---- composite: a user with mixed assignments ------------------------------
test('mixed assignments union correctly (regional north + property admin P3)', () => {
  const p = { assignments: [{ role: 'REGIONAL_MANAGER', groupId: 'north' }, { role: 'PROPERTY_ADMIN', propertyId: 'P3' }] };
  assert.deepEqual(ids(p), ['P1', 'P2', 'P3']);
  assert.equal(E.canWrite(p, world, 'P3'), true);
  assert.equal(E.canAccess(p, world, 'P4'), false);
});
