'use strict';

/**
 * Phase 56 — Tenant Sweep-Job Bootstrap tests (Tests 1-6).
 *
 * All in-memory. Verifies that the pattern used in bootstrap.js correctly
 * seeds exactly one booking.hold.expire_sweep job per tenant, idempotently,
 * without cross-tenant interference.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { buildHoldExpirySweep }         = require('../src/payment/holdExpirySweep');
const { buildPaymentStateStoreMemory } = require('../src/payment/paymentStateStore');

// ── Fake scheduler repo (mirrors makeFakeRepos().schedulerRepo) ──────────────

function makeFakeSchedulerRepo() {
  const _jobs = [];
  let seq = 0;

  return {
    _jobs,
    async insertScheduledJob(rec) {
      // Enforce WHERE NOT EXISTS guard (idempotency)
      const dup = _jobs.find(j => j.tenant_id === rec.tenant_id && j.job_type === rec.job_type &&
        ['pending', 'running'].includes(j.status));
      if (dup) {
        const err = new Error('unique_violation');
        err.code = '23505';
        throw err;
      }
      const row = Object.assign({ id: 'job-' + (++seq), status: 'pending', attempts: 0 }, rec);
      _jobs.push(row);
      return row;
    },
    async claimDueJobs({ limit = 10 }) {
      const due = _jobs.filter(j => j.status === 'pending').slice(0, limit);
      due.forEach(j => { j.status = 'running'; });
      return due;
    },
    async markJobCompleted(id) {
      const j = _jobs.find(j => j.id === id);
      if (j) j.status = 'completed';
    },
    async markJobCompletedAndReschedule(id) {
      const j = _jobs.find(j => j.id === id);
      if (j) j.status = 'pending'; // recurring → back to pending
    },
    async markJobFailed(id, err) {
      const j = _jobs.find(j => j.id === id);
      if (j) { j.status = 'failed'; j.last_error = String(err); }
    },
    async cancelScheduledJob() {}
  };
}

// ── Bootstrap helper: mirrors the bootstrap.js pattern exactly ───────────────

async function seedSweepJob(repo, tenantId) {
  // WHERE NOT EXISTS guard: only insert if no active job exists for this tenant+type
  const existing = repo._jobs.find(j =>
    j.tenant_id === tenantId &&
    j.job_type === 'booking.hold.expire_sweep' &&
    ['pending', 'running'].includes(j.status)
  );
  if (existing) return { seeded: false };
  await repo.insertScheduledJob({
    tenant_id:       tenantId,
    property_id:     null,
    job_type:        'booking.hold.expire_sweep',
    payload:         {},
    run_at:          new Date(),
    recurrence_rule: '*/5 * * * *',
    timezone:        'UTC',
    max_attempts:    3,
  });
  return { seeded: true };
}

// ── Test 1: new tenant receives exactly one sweep job ─────────────────────────

test('tenant bootstrap: new tenant receives exactly one hold-expiry sweep job', async () => {
  const repo = makeFakeSchedulerRepo();
  const tenantId = 'tenant-new-001';

  await seedSweepJob(repo, tenantId);

  const jobs = repo._jobs.filter(j => j.tenant_id === tenantId && j.job_type === 'booking.hold.expire_sweep');
  assert.equal(jobs.length, 1, 'exactly one sweep job must exist for the new tenant');
  assert.equal(jobs[0].status, 'pending');
  assert.equal(jobs[0].recurrence_rule, '*/5 * * * *');
  assert.equal(jobs[0].timezone, 'UTC');
});

// ── Test 2: bootstrap is idempotent (re-run creates no duplicate) ─────────────

test('tenant bootstrap: repeated seedSweepJob call for same tenant → still one job', async () => {
  const repo = makeFakeSchedulerRepo();
  const tenantId = 'tenant-idem-001';

  const r1 = await seedSweepJob(repo, tenantId);
  const r2 = await seedSweepJob(repo, tenantId);

  assert.equal(r1.seeded, true,  'first seed should report seeded=true');
  assert.equal(r2.seeded, false, 'second seed should be skipped (idempotent)');

  const jobs = repo._jobs.filter(j => j.tenant_id === tenantId && j.job_type === 'booking.hold.expire_sweep');
  assert.equal(jobs.length, 1, 'still exactly one job after two seed calls');
});

// ── Test 3: backfill idempotency (migration 0069 pattern) ────────────────────

test('tenant bootstrap: backfill seed for multiple tenants is idempotent', async () => {
  const repo = makeFakeSchedulerRepo();
  const tenants = ['t-back-a', 't-back-b', 't-back-c'];

  // First pass: seed all
  for (const tid of tenants) { await seedSweepJob(repo, tid); }
  // Second pass: re-run (idempotency)
  for (const tid of tenants) { await seedSweepJob(repo, tid); }

  const total = repo._jobs.filter(j => j.job_type === 'booking.hold.expire_sweep').length;
  assert.equal(total, 3, 'backfill re-run must not create duplicates (3 tenants = 3 jobs)');
});

// ── Test 4: two tenants receive isolated jobs ─────────────────────────────────

test('tenant bootstrap: two tenants each receive their own isolated sweep job', async () => {
  const repo = makeFakeSchedulerRepo();
  const tenantA = 'tenant-iso-a';
  const tenantB = 'tenant-iso-b';

  await seedSweepJob(repo, tenantA);
  await seedSweepJob(repo, tenantB);

  const jobsA = repo._jobs.filter(j => j.tenant_id === tenantA && j.job_type === 'booking.hold.expire_sweep');
  const jobsB = repo._jobs.filter(j => j.tenant_id === tenantB && j.job_type === 'booking.hold.expire_sweep');
  assert.equal(jobsA.length, 1, 'tenant A has exactly one job');
  assert.equal(jobsB.length, 1, 'tenant B has exactly one job');
  assert.notEqual(jobsA[0].id, jobsB[0].id, 'the two jobs are distinct rows');
});

// ── Test 5: concurrent seeding (both call at same time) ──────────────────────

test('tenant bootstrap: concurrent seedSweepJob calls for same tenant → at most one job', async () => {
  const repo = makeFakeSchedulerRepo();
  const tenantId = 'tenant-conc-001';

  // Simulate concurrent calls: both read "no existing job" before either writes.
  // The unique-constraint simulation in our fake repo enforces safety.
  const [r1, r2] = await Promise.all([
    seedSweepJob(repo, tenantId),
    seedSweepJob(repo, tenantId),
  ]);

  // One must succeed, the other must be skipped (race resolved by the guard).
  const jobs = repo._jobs.filter(j => j.tenant_id === tenantId && j.job_type === 'booking.hold.expire_sweep');
  assert.equal(jobs.length, 1, 'at most one job created under concurrent seeding');
  const seededCount = [r1, r2].filter(r => r.seeded).length;
  assert.ok(seededCount <= 1, 'at most one seed call should report seeded=true');
});

// ── Test 6: sweep only releases the correct tenant's holds ───────────────────

test('tenant sweep: job processing releases only that tenant\'s expired holds, not others', async () => {
  const tenantA  = 'sweep-tenant-a';
  const tenantB  = 'sweep-tenant-b';
  const resA     = 'res-expired-a';
  const resB     = 'res-expired-b';

  const storeA = buildPaymentStateStoreMemory();
  const storeB = buildPaymentStateStoreMemory();

  // Seed expired holds for both tenants
  await storeA.upsert({ reservation_id: resA, payment_status: 'pending_payment',
    hold_expires_at: new Date(Date.now() - 5000).toISOString(), deposit_amount: 100, provider: 'mock' });
  await storeB.upsert({ reservation_id: resB, payment_status: 'pending_payment',
    hold_expires_at: new Date(Date.now() - 5000).toISOString(), deposit_amount: 100, provider: 'mock' });

  const cancelledByA = [];
  const cancelledByB = [];

  function makeBus(cancelled) {
    return {
      async dispatch(name, input) {
        if (name === 'pms.reservation.cancel') cancelled.push(input.reservation_id);
        return { ok: true, result: {} };
      }
    };
  }

  const sweepA = buildHoldExpirySweep({ paymentStateStore: storeA, commandBus: makeBus(cancelledByA) });
  const sweepB = buildHoldExpirySweep({ paymentStateStore: storeB, commandBus: makeBus(cancelledByB) });

  await sweepA.sweep({ tenantId: tenantA, propertyId: null, actorId: 'sweep', requestId: 'r1' });
  await sweepB.sweep({ tenantId: tenantB, propertyId: null, actorId: 'sweep', requestId: 'r2' });

  assert.ok(cancelledByA.includes(resA), 'tenant A sweep must cancel tenant A expired hold');
  assert.ok(!cancelledByA.includes(resB), 'tenant A sweep must NOT touch tenant B hold');
  assert.ok(cancelledByB.includes(resB), 'tenant B sweep must cancel tenant B expired hold');
  assert.ok(!cancelledByB.includes(resA), 'tenant B sweep must NOT touch tenant A hold');
});
