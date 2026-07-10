'use strict';

/**
 * Phase 55 — Hold expiry sweep tests.
 * Verifies that buildHoldExpirySweep correctly identifies expired holds,
 * transitions payment state to 'failed', cancels the PMS reservation,
 * and is idempotent on repeated runs.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { buildHoldExpirySweep }         = require('../src/payment/holdExpirySweep');
const { buildPaymentStateStoreMemory } = require('../src/payment/paymentStateStore');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'sweep-test', actorId: null };

function fakeCommandBus() {
  const dispatched = [];
  let cancelErrors = false;
  return {
    dispatched,
    setCancelErrors(val) { cancelErrors = val; },
    async dispatch(name, input) {
      dispatched.push({ name, input });
      if (cancelErrors && name === 'pms.reservation.cancel') throw new Error('cancel_failed');
      return { ok: true, result: { id: input.reservation_id } };
    }
  };
}

function pastDate(ms = 1000) {
  return new Date(Date.now() - ms).toISOString();
}

function futureDate(ms = 900000) {
  return new Date(Date.now() + ms).toISOString();
}

// ── 1. No expired holds → swept: 0 ──────────────────────────────────────────

test('sweep: no expired holds → swept 0, no PMS dispatch', async () => {
  const store = buildPaymentStateStoreMemory();
  const bus = fakeCommandBus();
  const sweep = buildHoldExpirySweep({ paymentStateStore: store, commandBus: bus });

  const result = await sweep.sweep(CTX);
  assert.equal(result.swept, 0);
  assert.equal(result.errors, 0);
  assert.equal(bus.dispatched.length, 0);
});

// ── 2. One expired hold → swept: 1, PMS cancel dispatched, state = failed ───

test('sweep: one expired hold → swept 1, PMS cancel dispatched, payment_status=failed', async () => {
  const store = buildPaymentStateStoreMemory();
  const bus = fakeCommandBus();
  const sweep = buildHoldExpirySweep({ paymentStateStore: store, commandBus: bus });

  const resId = 'res-expired-1';
  await store.upsert({
    tenant_id: 't1', property_id: 'p1', reservation_id: resId,
    payment_status: 'pending_payment', hold_expires_at: pastDate(5000),
  });

  const result = await sweep.sweep(CTX);
  assert.equal(result.swept, 1);
  assert.equal(result.errors, 0);

  // PMS cancel must have been dispatched
  const cancels = bus.dispatched.filter((d) => d.name === 'pms.reservation.cancel');
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].input.reservation_id, resId);

  // Payment state must now be 'failed'
  const state = await store.getByReservationId(resId);
  assert.equal(state.payment_status, 'failed');
  assert.ok(state.failed_at, 'failed_at should be set');
});

// ── 3. Sweep idempotency: same expired hold swept twice → only one cancel ────

test('sweep: same expired hold swept twice → only one cancel dispatched (idempotent)', async () => {
  const store = buildPaymentStateStoreMemory();
  const bus = fakeCommandBus();
  const sweep = buildHoldExpirySweep({ paymentStateStore: store, commandBus: bus });

  const resId = 'res-idem-sweep';
  await store.upsert({
    tenant_id: 't1', property_id: 'p1', reservation_id: resId,
    payment_status: 'pending_payment', hold_expires_at: pastDate(5000),
  });

  const r1 = await sweep.sweep(CTX);
  const r2 = await sweep.sweep(CTX);

  assert.equal(r1.swept, 1, 'first sweep should process the hold');
  assert.equal(r2.swept, 0, 'second sweep should be a no-op (state is failed)');

  const cancels = bus.dispatched.filter((d) => d.name === 'pms.reservation.cancel');
  assert.equal(cancels.length, 1, 'exactly one PMS cancel for idempotent sweep pair');
});

// ── 4. Non-expired pending_payment hold → not swept ──────────────────────────

test('sweep: non-expired pending_payment hold → not swept', async () => {
  const store = buildPaymentStateStoreMemory();
  const bus = fakeCommandBus();
  const sweep = buildHoldExpirySweep({ paymentStateStore: store, commandBus: bus });

  await store.upsert({
    tenant_id: 't1', property_id: 'p1', reservation_id: 'res-future',
    payment_status: 'pending_payment', hold_expires_at: futureDate(900000),
  });

  const result = await sweep.sweep(CTX);
  assert.equal(result.swept, 0, 'non-expired hold must not be swept');
  assert.equal(bus.dispatched.length, 0);

  const state = await store.getByReservationId('res-future');
  assert.equal(state.payment_status, 'pending_payment', 'state unchanged');
});

// ── 5. PMS cancel throws → payment state still failed, errors stays 0 ────────

test('sweep: PMS cancel fails → payment_status still failed, not counted as error', async () => {
  const store = buildPaymentStateStoreMemory();
  const bus = fakeCommandBus();
  bus.setCancelErrors(true); // make PMS cancel throw
  const sweep = buildHoldExpirySweep({ paymentStateStore: store, commandBus: bus });

  const resId = 'res-cancel-fail';
  await store.upsert({
    tenant_id: 't1', property_id: 'p1', reservation_id: resId,
    payment_status: 'pending_payment', hold_expires_at: pastDate(3000),
  });

  const result = await sweep.sweep(CTX);
  // PMS cancel failure is logged but the record is still counted as swept
  // (state was already transitioned to 'failed' before the cancel attempt)
  assert.equal(result.swept, 1, 'hold should be counted as swept even if PMS cancel failed');
  assert.equal(result.errors, 0, 'PMS cancel failure should not increment errors counter');

  const state = await store.getByReservationId(resId);
  assert.equal(state.payment_status, 'failed', 'payment_status must be failed');
});

// ── 6. Paid hold with past hold_expires_at → not swept (only pending_payment) ─

test('sweep: paid hold with past hold_expires_at → not swept', async () => {
  const store = buildPaymentStateStoreMemory();
  const bus = fakeCommandBus();
  const sweep = buildHoldExpirySweep({ paymentStateStore: store, commandBus: bus });

  await store.upsert({
    tenant_id: 't1', property_id: 'p1', reservation_id: 'res-paid',
    payment_status: 'paid', hold_expires_at: pastDate(10000),
  });

  const result = await sweep.sweep(CTX);
  assert.equal(result.swept, 0, 'paid holds must never be swept');
  assert.equal(bus.dispatched.length, 0);
});

// ── 7. Mixed: one expired pending + one unexpired pending + one paid ──────────

test('sweep: mixed holds → only the expired pending_payment hold is swept', async () => {
  const store = buildPaymentStateStoreMemory();
  const bus = fakeCommandBus();
  const sweep = buildHoldExpirySweep({ paymentStateStore: store, commandBus: bus });

  await store.upsert({ tenant_id: 't1', property_id: 'p1', reservation_id: 'res-exp',
    payment_status: 'pending_payment', hold_expires_at: pastDate(5000) });
  await store.upsert({ tenant_id: 't1', property_id: 'p1', reservation_id: 'res-active',
    payment_status: 'pending_payment', hold_expires_at: futureDate(900000) });
  await store.upsert({ tenant_id: 't1', property_id: 'p1', reservation_id: 'res-paid2',
    payment_status: 'paid', hold_expires_at: pastDate(1000) });

  const result = await sweep.sweep(CTX);
  assert.equal(result.swept, 1, 'only one hold should be swept');

  assert.equal((await store.getByReservationId('res-exp')).payment_status, 'failed');
  assert.equal((await store.getByReservationId('res-active')).payment_status, 'pending_payment');
  assert.equal((await store.getByReservationId('res-paid2')).payment_status, 'paid');

  const cancels = bus.dispatched.filter((d) => d.name === 'pms.reservation.cancel');
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].input.reservation_id, 'res-exp');
});
