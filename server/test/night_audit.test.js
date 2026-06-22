'use strict';

/** Phase 16 - Night Audit / Day-End Engine (Business Date architecture). */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMemoryNightAuditRepo } = require('../src/nightaudit/repository/nightAuditRepo.memory');
const { buildNightAuditSystem } = require('../src/nightaudit/core/NightAuditSystem');
const { buildNightAuditSubscriber } = require('../src/nightaudit/services/nightAuditSubscriber');

const CTX = (propertyId, userId = 'auditor-1') => ({ tenantId: 't1', propertyId, requestId: 'rq', userId });

// Minimal local bus: captures published events AND fans out to subscribers.
function makeBus() {
  const events = [];
  const subs = new Map();
  return {
    events,
    async publish(e) { events.push(e); for (const h of (subs.get(e.event_type) || [])) await h(e); },
    subscribe(t, h) { const a = subs.get(t) || []; a.push(h); subs.set(t, a); return () => {}; }
  };
}

function fresh() {
  const bus = makeBus();
  const repo = buildMemoryNightAuditRepo();
  const sys = buildNightAuditSystem({ repo, eventBus: bus });
  buildNightAuditSubscriber({ eventBus: bus, repo });
  return { bus, repo, sys };
}
const types = (bus) => bus.events.map((e) => e.event_type);

test('business date lifecycle: OPEN -> AUDIT_PENDING -> closed advances date', async () => {
  const { sys } = fresh();
  const ctx = CTX('PA');
  await sys.businessDate.setBusinessDate(ctx, '2026-06-22');
  assert.equal(await sys.businessDate.getStatus(ctx), 'OPEN');
  await sys.businessDate.markPending(ctx);
  assert.equal(await sys.businessDate.getStatus(ctx), 'AUDIT_PENDING');
  const closed = await sys.businessDate.markClosed(ctx);
  assert.equal(closed.currentBusinessDate, '2026-06-23');
  assert.equal(closed.lastClosedDate, '2026-06-22');
  assert.equal(closed.status, 'OPEN');
});

test('successful night audit advances the business date and emits lifecycle events', async () => {
  const { sys, bus } = fresh();
  const ctx = CTX('PA');
  await sys.businessDate.setBusinessDate(ctx, '2026-06-22');
  const r = await sys.audit.runNightAudit(ctx, {});
  assert.equal(r.ok, true);
  assert.equal(r.run.status, 'COMPLETED');
  assert.equal((await sys.businessDate.getBusinessDate(ctx)).currentBusinessDate, '2026-06-23');
  assert.equal(await sys.lock.isLocked(ctx), false);   // unlocked after completion
  const t = types(bus);
  for (const ev of ['dayend.started', 'dayend.completed', 'businessdate.changed', 'financial.locked', 'financial.unlocked']) {
    assert.ok(t.includes(ev), 'missing event ' + ev);
  }
});

test('blocking validation fails the audit (date not advanced); force overrides', async () => {
  const { sys, repo } = fresh();
  const ctx = CTX('PA');
  await sys.businessDate.setBusinessDate(ctx, '2026-06-22');
  // one stay ended but its invoice not finalized => 1 open folio (blocking)
  await repo.bumpActivity('PA', 'staysEnded');

  const fail = await sys.audit.runNightAudit(ctx, {});
  assert.equal(fail.ok, false);
  assert.ok(fail.blocking.some((b) => b.code === 'open_folios'));
  assert.equal(fail.run.status, 'FAILED');
  assert.equal((await sys.businessDate.getBusinessDate(ctx)).currentBusinessDate, '2026-06-22'); // not advanced
  assert.equal(await sys.businessDate.getStatus(ctx), 'AUDIT_PENDING');

  // resolve the open folio, then it passes
  await repo.bumpActivity('PA', 'invoicesFinalized');
  const ok = await sys.audit.runNightAudit(ctx, {});
  assert.equal(ok.ok, true);
  assert.equal((await sys.businessDate.getBusinessDate(ctx)).currentBusinessDate, '2026-06-23');
});

test('financial lock restricts only accounting-sensitive ops (operational continuity)', async () => {
  const { sys } = fresh();
  const ctx = CTX('PA');
  await sys.lock.lockAccountingFunctions(ctx, { businessDate: '2026-06-22' });
  assert.equal(await sys.lock.isLocked(ctx), true);
  assert.equal(await sys.lock.isOperationAllowed(ctx, { accountingSensitive: true }), false);
  assert.equal(await sys.lock.isOperationAllowed(ctx, { accountingSensitive: false }), true); // front desk etc.
  await sys.lock.unlockAccountingFunctions(ctx);
  assert.equal(await sys.lock.isOperationAllowed(ctx, { accountingSensitive: true }), true);
});

test('pending (failed) audit keeps accounting locked but operations continue; banner shows', async () => {
  const { sys, repo } = fresh();
  const ctx = CTX('PA');
  await sys.businessDate.setBusinessDate(ctx, '2026-06-22');
  await repo.bumpActivity('PA', 'staysEnded');                       // force a block
  await sys.audit.runNightAudit(ctx, {});
  assert.equal(await sys.lock.isLocked(ctx), true);                  // locked while pending
  assert.equal(await sys.lock.isOperationAllowed(ctx, { accountingSensitive: false }), true);
  assert.deepEqual(await sys.dashboard.banner(ctx), ['Business Date Not Closed', 'Night Audit Pending']);
});

test('scheduler: manual, automatic sweep, and retry of failed runs', async () => {
  const { sys, repo } = fresh();
  await sys.businessDate.setBusinessDate(CTX('PA'), '2026-06-22');
  // manual
  const m = await sys.scheduler.runManual(CTX('PA'), {});
  assert.equal(m.ok, true);

  // automatic sweep: PB is behind asOfDate
  await sys.businessDate.setBusinessDate(CTX('PB'), '2026-06-20');
  const swept = await sys.scheduler.runDue({ asOfDate: '2026-06-23', ctxFor: (pid) => CTX(pid, 'system') });
  assert.ok(swept.find((s) => s.propertyId === 'PB' && s.ok));

  // retry: force a failure on PA's new day then retry with resolution
  await repo.bumpActivity('PA', 'staysEnded');
  const f = await sys.scheduler.runAutomatic(CTX('PA'), {});
  assert.equal(f.ok, false);
  await repo.bumpActivity('PA', 'invoicesFinalized');
  const retry = await sys.scheduler.retryFailed(CTX('PA'), {});
  assert.equal(retry.ok, true);
});

test('exception handling: raise, list, resolve', async () => {
  const { sys } = fresh();
  const ctx = CTX('PA');
  const ex = await sys.exceptions.raise(ctx, { category: 'FINANCIAL', code: 'unbalanced', message: 'x', blocking: true });
  let open = await sys.exceptions.list(ctx, { resolved: false });
  assert.equal(open.length, 1);
  await sys.exceptions.resolve(ctx, ex.id, { resolution: 'corrected' });
  open = await sys.exceptions.list(ctx, { resolved: false });
  assert.equal(open.length, 0);
});

test('audit history records runs', async () => {
  const { sys } = fresh();
  const ctx = CTX('PA');
  await sys.businessDate.setBusinessDate(ctx, '2026-06-22');
  await sys.audit.runNightAudit(ctx, {});
  const hist = await sys.audit.getAuditHistory(ctx);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].status, 'COMPLETED');
});

test('subscriber feeds activity from events, driving validation', async () => {
  const { sys, bus } = fresh();
  const ctx = CTX('PA');
  await sys.businessDate.setBusinessDate(ctx, '2026-06-22');
  await bus.publish({ event_type: 'stay.ended', property_id: 'PA', payload: { room_id: 'RM1' } });
  let v = await sys.audit.validateDayEnd(ctx, {});
  assert.equal(v.ok, false);                                          // open folio from stay.ended
  await bus.publish({ event_type: 'invoice.finalized', property_id: 'PA', payload: { folio_id: 'F1' } });
  v = await sys.audit.validateDayEnd(ctx, {});
  assert.equal(v.ok, true);                                           // balanced
});

test('multi-property isolation', async () => {
  const { sys } = fresh();
  await sys.businessDate.setBusinessDate(CTX('PA'), '2026-06-22');
  await sys.businessDate.setBusinessDate(CTX('PB'), '2026-06-22');
  await sys.audit.runNightAudit(CTX('PA'), {});
  assert.equal((await sys.businessDate.getBusinessDate(CTX('PA'))).currentBusinessDate, '2026-06-23');
  assert.equal((await sys.businessDate.getBusinessDate(CTX('PB'))).currentBusinessDate, '2026-06-22'); // unaffected
  assert.equal((await sys.audit.getAuditHistory(CTX('PB'))).length, 0);
});
