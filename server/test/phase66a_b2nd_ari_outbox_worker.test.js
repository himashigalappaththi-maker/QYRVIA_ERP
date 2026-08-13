'use strict';

/**
 * Phase 66A-B2N-D — behavioural tests for the ARI outbox drain worker and its
 * tenant resolver.
 *
 * These exercise the REAL committed modules against fake wrappers. They assert
 * BEHAVIOUR — which transition ran, how many times, with what timestamp, and
 * which tenant it was routed through — not source text. The static contract
 * file (phase66a_b2nd_ari_outbox_worker_contract.test.js) is a separate,
 * architectural guard and is not a substitute for these.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAriOutboxWorker, computeRetryDelayMs, RETRY_BASE_MS, RETRY_MAX_MS
} = require('../src/ari/outbox/ariOutboxWorker');
const { buildAriOutboxTenantResolver } = require('../src/ari/outbox/ariOutboxTenantResolver');

const T_A = '11111111-1111-4111-8111-111111111111';
const T_B = '22222222-2222-4222-8222-222222222222';

const FIXED_NOW = new Date('2026-08-01T12:00:00.000Z');

/** A persisted-shaped outbox row (snake_case, exactly as claimDue returns). */
function row(over = {}) {
  return Object.assign({
    id: 'row-1',
    tenant_id: T_A,
    property_id: 'prop-1',
    event_type: 'AVAILABILITY_CHANGED',
    resource_kind: 'AVAILABILITY',
    room_type_id: 'rt-1',
    rate_plan_id: null,
    restriction_rule_id: null,
    effective_from: '2026-08-01',
    effective_to: '2026-08-31',
    dedupe_key: 'aob:v1:' + 'a'.repeat(64),
    source_version: 3,
    payload_json: { source: 'ari_api' },
    status: 'PROCESSING',
    attempts: 0,
    retry_count: 0,
    max_retries: 5,
    next_retry_at: null,
    lease_until: null,
    lease_owner: null
  }, over);
}

/** Records every wrapper call, per tenant, so isolation can be asserted. */
function fakeOutbox({ claims = {}, recovered = {}, throwOn = null } = {}) {
  const calls = [];
  const rec = (name, args) => calls.push({ name, tenantId: args.tenantId, id: args.id, nextRetryAt: args.nextRetryAt });
  return {
    calls,
    byTenant(tenantId) { return calls.filter((c) => c.tenantId === tenantId); },
    named(name) { return calls.filter((c) => c.name === name); },
    async requeueExpiredLeasesForTenant(args) {
      rec('requeue', args);
      return recovered[args.tenantId] || [];
    },
    async claimDueForTenant(args) {
      rec('claim', args);
      return claims[args.tenantId] || [];
    },
    async markCompletedForTenant(args) {
      rec('complete', args);
      if (throwOn === 'complete') throw new Error('transition_failed');
      return {};
    },
    async markRetryScheduledForTenant(args) {
      rec('retry', args);
      return {};
    },
    async markDeadLetterForTenant(args) {
      rec('deadletter', args);
      return {};
    }
  };
}

function fakeResolver(tenants, opts = {}) {
  const state = { calls: 0, lastLimit: null };
  return {
    state,
    async resolveDueTenants({ limit } = {}) {
      state.calls += 1;
      state.lastLimit = limit;
      if (opts.throws) throw new Error('resolver_down');
      return tenants;
    }
  };
}

function fakeDispatcher({ ready = true, behaviour = () => {} } = {}) {
  const seen = [];
  return {
    seen,
    isReady: () => ready,
    async dispatch(envelope) {
      seen.push(envelope);
      return behaviour(envelope, seen.length);
    }
  };
}

const POOL = { query: async () => ({ rows: [] }) };

function makeWorker(over = {}) {
  return buildAriOutboxWorker(Object.assign({
    tenantResolver: fakeResolver([T_A]),
    outbox: fakeOutbox(),
    pool: POOL,
    dispatcher: fakeDispatcher(),
    clock: () => FIXED_NOW,
    workerId: 'w-test-1',
    config: { isEnabled: () => true, isDispatchEnabled: () => true }
  }, over));
}

// ---------------------------------------------------------------------------
// A1 / A2 — the gates
// ---------------------------------------------------------------------------

test('A1. both gates OFF: no resolver call, no claim, no dispatch, no transition', async () => {
  for (const cfg of [
    { isEnabled: () => false, isDispatchEnabled: () => false },
    { isEnabled: () => false, isDispatchEnabled: () => true },
    { isEnabled: () => true,  isDispatchEnabled: () => false }
  ]) {
    const resolver = fakeResolver([T_A]);
    const outbox = fakeOutbox({ claims: { [T_A]: [row()] } });
    const dispatcher = fakeDispatcher();
    const w = makeWorker({ tenantResolver: resolver, outbox, dispatcher, config: cfg });

    const c = await w.tick();

    assert.equal(resolver.state.calls, 0, 'the BYPASSRLS resolver must not be called');
    assert.equal(outbox.calls.length, 0, 'no claim and no transition');
    assert.equal(dispatcher.seen.length, 0);
    assert.equal(c.ticksSkipped, 1);
    assert.equal(c.rowsClaimed, 0);
    assert.equal(c.tenantsResolved, 0);
  }
});

test('A1b. any gate value other than boolean true fails closed', async () => {
  // The worker's gate contract is a predicate returning a BOOLEAN — the
  // env-string comparison (`env.X === 'true'`) happens one layer up, in the
  // boot wiring, and is asserted by the static contract test. Here the point
  // is that the worker uses strict `=== true`, so a truthy-but-not-true value
  // ('TRUE', 1, 'yes') can never open the gate by accident.
  for (const v of ['true', 'TRUE', 'yes', '1', ' true', 1, {}, [], null, undefined]) {
    const resolver = fakeResolver([T_A]);
    const w = makeWorker({
      tenantResolver: resolver,
      config: { isEnabled: () => v, isDispatchEnabled: () => v }
    });
    const c = await w.tick();
    assert.equal(resolver.state.calls, 0, 'gate value ' + JSON.stringify(v) + ' must not enable work');
    assert.equal(c.ticksSkipped, 1);
  }

  // And the one value that does open it, so this test cannot pass vacuously.
  const resolver = fakeResolver([T_A]);
  const w = makeWorker({
    tenantResolver: resolver,
    config: { isEnabled: () => true, isDispatchEnabled: () => true }
  });
  const c = await w.tick();
  assert.equal(resolver.state.calls, 1);
  assert.equal(c.ticksSkipped, 0);
});

test('A2. gates ON but dispatcher NOT ready: no resolver call, no claim', async () => {
  const resolver = fakeResolver([T_A]);
  const outbox = fakeOutbox({ claims: { [T_A]: [row()] } });
  const w = makeWorker({ tenantResolver: resolver, outbox, dispatcher: fakeDispatcher({ ready: false }) });

  const c = await w.tick();

  assert.equal(resolver.state.calls, 0);
  assert.equal(outbox.calls.length, 0);
  assert.equal(c.ticksSkipped, 1);
});

test('A2b. a dispatcher with no isReady() is treated as NOT ready', async () => {
  const resolver = fakeResolver([T_A]);
  const w = makeWorker({
    tenantResolver: resolver,
    dispatcher: { dispatch: async () => {} }   // no isReady
  });
  const c = await w.tick();
  assert.equal(resolver.state.calls, 0, 'a missing readiness signal is never consent');
  assert.equal(c.ticksSkipped, 1);
});

// ---------------------------------------------------------------------------
// A3-A6 — the per-row state machine
// ---------------------------------------------------------------------------

test('A3. a successful dispatch claims once and completes once', async () => {
  const outbox = fakeOutbox({ claims: { [T_A]: [row()] } });
  const dispatcher = fakeDispatcher();
  const w = makeWorker({ outbox, dispatcher });

  const c = await w.tick();

  assert.equal(dispatcher.seen.length, 1, 'dispatcher invoked exactly once');
  assert.equal(outbox.named('complete').length, 1);
  assert.equal(outbox.named('retry').length, 0);
  assert.equal(outbox.named('deadletter').length, 0);
  assert.equal(c.rowsClaimed, 1);
  assert.equal(c.rowsCompleted, 1);
  assert.equal(c.tenantsProcessed, 1);
});

test('A4. a retryable failure schedules exactly one retry at the exact deterministic time', async () => {
  const outbox = fakeOutbox({ claims: { [T_A]: [row({ retry_count: 2, max_retries: 5 })] } });
  const dispatcher = fakeDispatcher({ behaviour: () => { throw new Error('boom'); } });
  const w = makeWorker({ outbox, dispatcher });

  const c = await w.tick();

  const retries = outbox.named('retry');
  assert.equal(retries.length, 1);
  assert.equal(outbox.named('complete').length, 0);
  assert.equal(outbox.named('deadletter').length, 0);
  assert.equal(c.rowsRetried, 1);

  // retry_count 2 -> 30000 * 2^2 = 120000ms after the injected clock.
  const expected = new Date(FIXED_NOW.getTime() + 120000);
  assert.ok(retries[0].nextRetryAt instanceof Date);
  assert.equal(retries[0].nextRetryAt.getTime(), expected.getTime());
});

test('A5. exhausted retries dead-letter exactly once and never schedule a retry', async () => {
  // retry_count 4, max_retries 5: the next retry would make retry_count 5,
  // which claimDue's `retry_count < max_retries` would never select again —
  // the row would sit PENDING forever. Dead-letter instead.
  const outbox = fakeOutbox({ claims: { [T_A]: [row({ retry_count: 4, max_retries: 5 })] } });
  const dispatcher = fakeDispatcher({ behaviour: () => { throw new Error('boom'); } });
  const w = makeWorker({ outbox, dispatcher });

  const c = await w.tick();

  assert.equal(outbox.named('deadletter').length, 1);
  assert.equal(outbox.named('retry').length, 0);
  assert.equal(outbox.named('complete').length, 0);
  assert.equal(c.rowsDeadLettered, 1);
  assert.equal(c.rowsRetried, 0);
});

test('A6. an explicitly non-retryable failure dead-letters immediately, with retries left', async () => {
  const outbox = fakeOutbox({ claims: { [T_A]: [row({ retry_count: 0, max_retries: 5 })] } });
  const dispatcher = fakeDispatcher({
    behaviour: () => { throw Object.assign(new Error('nope'), { retryable: false }); }
  });
  const w = makeWorker({ outbox, dispatcher });

  const c = await w.tick();

  assert.equal(outbox.named('deadletter').length, 1);
  assert.equal(outbox.named('retry').length, 0, 'non-retryable must not consume a retry slot');
  assert.equal(c.rowsDeadLettered, 1);
});

test('A7. one failed row does not prevent a later row from completing', async () => {
  const outbox = fakeOutbox({
    claims: { [T_A]: [row({ id: 'bad' }), row({ id: 'good' })] }
  });
  const dispatcher = fakeDispatcher({
    behaviour: (env) => { if (env.id === 'bad') throw new Error('boom'); }
  });
  const w = makeWorker({ outbox, dispatcher });

  const c = await w.tick();

  assert.equal(dispatcher.seen.length, 2, 'both rows were attempted');
  assert.deepEqual(outbox.named('retry').map((x) => x.id), ['bad']);
  assert.deepEqual(outbox.named('complete').map((x) => x.id), ['good']);
  assert.equal(c.rowsCompleted, 1);
  assert.equal(c.rowsRetried, 1);
});

test('A7b. a transition failure is counted, not thrown, and the tick continues', async () => {
  const outbox = fakeOutbox({ claims: { [T_A]: [row()] }, throwOn: 'complete' });
  const w = makeWorker({ outbox });

  const c = await w.tick();

  assert.equal(c.rowsFailed, 1);
  assert.equal(c.rowsCompleted, 0, 'a failed transition must not be counted as completed');
});

// ---------------------------------------------------------------------------
// A8 — recovery ordering
// ---------------------------------------------------------------------------

test('A8. expired leases are recovered BEFORE the claim, in that order', async () => {
  const outbox = fakeOutbox({
    claims: { [T_A]: [row()] },
    recovered: { [T_A]: [row({ id: 'r1' }), row({ id: 'r2' })] }
  });
  const w = makeWorker({ outbox });

  const c = await w.tick();

  const order = outbox.byTenant(T_A).map((x) => x.name);
  assert.equal(order[0], 'requeue', 'recovery must run before the claim');
  assert.equal(order[1], 'claim');
  assert.equal(c.leasesRecovered, 2);
});

// ---------------------------------------------------------------------------
// A9 — tenant isolation
// ---------------------------------------------------------------------------

test('A9. tenant A and tenant B never receive each other rows', async () => {
  const outbox = fakeOutbox({
    claims: { [T_A]: [row({ id: 'a1', tenant_id: T_A })],
              [T_B]: [row({ id: 'b1', tenant_id: T_B })] }
  });
  const w = makeWorker({ tenantResolver: fakeResolver([T_A, T_B]), outbox });

  const c = await w.tick();

  for (const call of outbox.byTenant(T_A)) {
    assert.ok(call.id === undefined || call.id === 'a1', 'tenant A wrapper saw ' + call.id);
  }
  for (const call of outbox.byTenant(T_B)) {
    assert.ok(call.id === undefined || call.id === 'b1', 'tenant B wrapper saw ' + call.id);
  }
  assert.equal(c.tenantsResolved, 2);
  assert.equal(c.tenantsProcessed, 2);
  assert.equal(c.rowsCompleted, 2);
});

test('A9b. one tenant failing does not stop the next tenant', async () => {
  const outbox = fakeOutbox({ claims: { [T_B]: [row({ id: 'b1', tenant_id: T_B })] } });
  const origClaim = outbox.claimDueForTenant.bind(outbox);
  outbox.claimDueForTenant = async (args) => {
    if (args.tenantId === T_A) throw new Error('tenant_a_down');
    return origClaim(args);
  };
  const w = makeWorker({ tenantResolver: fakeResolver([T_A, T_B]), outbox });

  const c = await w.tick();

  assert.equal(c.rowsCompleted, 1, 'tenant B still drained');
  assert.equal(c.tenantsProcessed, 1);
  assert.equal(c.rowsFailed, 1);
});

// ---------------------------------------------------------------------------
// A10 / A11 — the delivery envelope and the counters
// ---------------------------------------------------------------------------

test('A10. the dispatcher receives the complete delivery envelope, unmutated', async () => {
  const source = row({
    restriction_rule_id: 'rule-9', rate_plan_id: 'rp-1', source_version: 7,
    dedupe_key: 'aob:v2:' + 'b'.repeat(64)
  });
  const outbox = fakeOutbox({ claims: { [T_A]: [source] } });
  const dispatcher = fakeDispatcher();
  const w = makeWorker({ outbox, dispatcher });

  await w.tick();

  const env = dispatcher.seen[0];
  assert.equal(env.eventType, 'AVAILABILITY_CHANGED');
  assert.equal(env.resourceKind, 'AVAILABILITY');
  assert.equal(env.restrictionRuleId, 'rule-9');
  assert.equal(env.roomTypeId, 'rt-1');
  assert.equal(env.ratePlanId, 'rp-1');
  assert.equal(env.dedupeKey, 'aob:v2:' + 'b'.repeat(64));
  assert.equal(env.sourceVersion, 7);
  assert.deepEqual(env.payload, { source: 'ari_api' });
  assert.equal(env.tenantId, T_A);
  assert.equal(env.propertyId, 'prop-1');
});

test('A10b. the envelope is frozen, so a dispatcher cannot mutate worker state', async () => {
  const source = row();
  const outbox = fakeOutbox({ claims: { [T_A]: [source] } });
  const dispatcher = fakeDispatcher({
    behaviour: (env) => { try { env.sourceVersion = 999; } catch (e) { /* frozen */ } }
  });
  const w = makeWorker({ outbox, dispatcher });

  await w.tick();

  assert.equal(dispatcher.seen[0].sourceVersion, 3, 'envelope must be immutable');
  assert.equal(source.source_version, 3, 'the persisted row must be untouched');
});

test('A11. counters are exact and carry no payload, dedupe key or secret', async () => {
  const outbox = fakeOutbox({
    claims: { [T_A]: [row({ id: 'ok' }), row({ id: 'retry', retry_count: 1 }),
                      row({ id: 'dead', retry_count: 4, max_retries: 5 })] },
    recovered: { [T_A]: [row({ id: 'rec' })] }
  });
  const dispatcher = fakeDispatcher({
    behaviour: (env) => { if (env.id !== 'ok') throw new Error('boom'); }
  });
  const w = makeWorker({ outbox, dispatcher });

  const c = await w.tick();

  assert.deepEqual(c, {
    tenantsResolved: 1,
    tenantsProcessed: 1,
    leasesRecovered: 1,
    rowsClaimed: 3,
    rowsCompleted: 1,
    rowsRetried: 1,
    rowsDeadLettered: 1,
    rowsFailed: 0,
    ticksSkipped: 0
  });

  const serialised = JSON.stringify(c);
  assert.ok(!/aob:v/.test(serialised), 'no dedupe key in counters');
  assert.ok(!/ari_api|payload/.test(serialised), 'no payload in counters');
  assert.ok(!/1111|2222/.test(serialised), 'no tenant identifier in counters');
});

// ---------------------------------------------------------------------------
// A12 / A13 — the resolver
// ---------------------------------------------------------------------------

test('A12. the resolver fails closed on a malformed tenant identifier', async () => {
  for (const bad of ['not-a-uuid', '', null, 42, {}, '11111111-1111-4111-8111-11111111111']) {
    const resolver = buildAriOutboxTenantResolver({
      pool: { query: async () => ({ rows: [{ tenant_id: bad }] }) }
    });
    await assert.rejects(() => resolver.resolveDueTenants({ limit: 10 }),
      /non-UUID tenant identifier/, 'must reject ' + JSON.stringify(bad));
  }
});

test('A12b. the malformed-identifier error never echoes the offending value', async () => {
  const secretish = 'SECRET-LOOKING-VALUE-FROM-A-DEFINER-CONTEXT';
  const resolver = buildAriOutboxTenantResolver({
    pool: { query: async () => ({ rows: [{ tenant_id: secretish }] }) }
  });
  await assert.rejects(() => resolver.resolveDueTenants({ limit: 10 }),
    (e) => !e.message.includes(secretish));
});

test('A13. the resolver deduplicates defensively, case-insensitively', async () => {
  const dup = T_A.toUpperCase();
  const resolver = buildAriOutboxTenantResolver({
    pool: { query: async () => ({ rows: [{ tenant_id: T_A }, { tenant_id: dup }, { tenant_id: T_B }] }) }
  });
  const out = await resolver.resolveDueTenants({ limit: 10 });
  assert.deepEqual(out, [T_A, T_B], 'one entry per tenant, first spelling wins');
});

test('A13b. the resolver calls ONLY the approved function, with the limit bound as a parameter', async () => {
  const seen = [];
  const resolver = buildAriOutboxTenantResolver({
    pool: { query: async (sql, params) => { seen.push({ sql, params }); return { rows: [] }; } }
  });
  await resolver.resolveDueTenants({ limit: 7 });

  assert.equal(seen.length, 1, 'exactly one query per resolution');
  assert.match(seen[0].sql, /worker_resolvers\.due_ari_outbox_tenants\(\$1\)/);
  assert.deepEqual(seen[0].params, [7], 'the limit is bound, never interpolated');
  assert.ok(!/\btenants\b(?!_)/i.test(seen[0].sql), 'must never query the tenants table');
  assert.ok(!/ari_outbox_store/i.test(seen[0].sql), 'must never query the outbox directly');
});

test('A13c. the resolver rejects an out-of-range limit before issuing any SQL', async () => {
  let queried = false;
  const resolver = buildAriOutboxTenantResolver({
    pool: { query: async () => { queried = true; return { rows: [] }; } }
  });
  for (const bad of [0, -1, 1001, 1.5, NaN, null, '10']) {
    await assert.rejects(() => resolver.resolveDueTenants({ limit: bad }), /limit must be an integer/);
  }
  assert.equal(queried, false, 'no SQL may be issued for an invalid limit');
});

// ---------------------------------------------------------------------------
// A14 / A15 / A16 — construction, identity, and the no-success-dispatcher rule
// ---------------------------------------------------------------------------

test('A14. the worker fails closed when any required dependency is missing', () => {
  const base = {
    tenantResolver: fakeResolver([]), outbox: fakeOutbox(), pool: POOL,
    dispatcher: fakeDispatcher(), workerId: 'w1'
  };
  for (const k of ['tenantResolver', 'outbox', 'pool', 'dispatcher', 'workerId']) {
    const d = Object.assign({}, base);
    delete d[k];
    assert.throws(() => buildAriOutboxWorker(d), /ariOutboxWorker:/, 'missing ' + k + ' must throw');
  }
  assert.throws(() => buildAriOutboxWorker(), /ariOutboxWorker:/);
});

test('A14b. an outbox missing any single wrapper is rejected', () => {
  const full = fakeOutbox();
  for (const k of ['claimDueForTenant', 'markCompletedForTenant', 'markRetryScheduledForTenant',
                   'markDeadLetterForTenant', 'requeueExpiredLeasesForTenant']) {
    const partial = Object.assign({}, full);
    delete partial[k];
    assert.throws(() => buildAriOutboxWorker({
      tenantResolver: fakeResolver([]), outbox: partial, pool: POOL,
      dispatcher: fakeDispatcher(), workerId: 'w1'
    }), /tenant-bound outbox wrappers required/, 'missing ' + k);
  }
});

test('A15. the lease owner is stable within an instance and distinct between instances', async () => {
  const outbox = fakeOutbox({ claims: { [T_A]: [row()] } });
  const w1 = makeWorker({ outbox, workerId: 'worker-one' });
  await w1.tick();
  await w1.tick();

  const owners = [];
  const capturing = fakeOutbox({ claims: { [T_A]: [row()] } });
  capturing.claimDueForTenant = async (args) => { owners.push(args.leaseOwner); return [row()]; };

  const a = buildAriOutboxWorker({
    tenantResolver: fakeResolver([T_A]), outbox: capturing, pool: POOL,
    dispatcher: fakeDispatcher(), clock: () => FIXED_NOW, workerId: 'worker-A',
    config: { isEnabled: () => true, isDispatchEnabled: () => true }
  });
  const b = buildAriOutboxWorker({
    tenantResolver: fakeResolver([T_A]), outbox: capturing, pool: POOL,
    dispatcher: fakeDispatcher(), clock: () => FIXED_NOW, workerId: 'worker-B',
    config: { isEnabled: () => true, isDispatchEnabled: () => true }
  });
  await a.tick(); await a.tick(); await b.tick();

  assert.deepEqual(owners, ['worker-A', 'worker-A', 'worker-B']);
  assert.equal(a.workerId, 'worker-A');
  assert.notEqual(a.workerId, b.workerId);
});

test('A16. the production boot dispatcher cannot acknowledge success', async () => {
  // Mirrors exactly what src/index.js constructs: not ready, and throwing
  // non-retryably if it is ever reached. A mock-success dispatcher would mark
  // real events COMPLETED without delivering them.
  const notReady = {
    isReady: () => false,
    dispatch: async () => {
      throw Object.assign(new Error('ari_outbox_dispatch_not_implemented'), { retryable: false });
    }
  };
  const outbox = fakeOutbox({ claims: { [T_A]: [row()] } });
  const w = makeWorker({ outbox, dispatcher: notReady });

  const c = await w.tick();

  assert.equal(c.ticksSkipped, 1);
  assert.equal(outbox.named('complete').length, 0, 'nothing may ever be completed by the stub');
  assert.equal(c.rowsCompleted, 0);
});

// ---------------------------------------------------------------------------
// Retry formula
// ---------------------------------------------------------------------------

test('the retry formula is min(30000 * 2^retry_count, 3600000), deterministic and bounded', () => {
  assert.equal(RETRY_BASE_MS, 30000);
  assert.equal(RETRY_MAX_MS, 3600000);
  assert.equal(computeRetryDelayMs(0), 30000);
  assert.equal(computeRetryDelayMs(1), 60000);
  assert.equal(computeRetryDelayMs(2), 120000);
  assert.equal(computeRetryDelayMs(3), 240000);
  assert.equal(computeRetryDelayMs(6), 1920000);
  assert.equal(computeRetryDelayMs(7), 3600000, 'capped at one hour');
  assert.equal(computeRetryDelayMs(100), 3600000, 'still capped');

  // Corrupt input must not produce a negative, NaN or infinite delay.
  for (const bad of [-5, null, undefined, NaN, 'x', 1.5]) {
    const d = computeRetryDelayMs(bad);
    assert.ok(Number.isFinite(d) && d > 0 && d <= RETRY_MAX_MS, 'bad input ' + String(bad) + ' -> ' + d);
  }

  // Deterministic: same input, same output, every time.
  assert.equal(computeRetryDelayMs(3), computeRetryDelayMs(3));
});

test('a resolver outage skips the tick without claiming or failing rows', async () => {
  const outbox = fakeOutbox({ claims: { [T_A]: [row()] } });
  const w = makeWorker({ tenantResolver: fakeResolver([T_A], { throws: true }), outbox });

  const c = await w.tick();

  assert.equal(c.ticksSkipped, 1);
  assert.equal(c.rowsClaimed, 0);
  assert.equal(c.rowsFailed, 0, 'no row failed — none was ever claimed');
  assert.equal(outbox.calls.length, 0);
});

test('the worker asks the resolver for a bounded tenant list', async () => {
  const resolver = fakeResolver([T_A]);
  const w = makeWorker({ tenantResolver: resolver, config: {
    isEnabled: () => true, isDispatchEnabled: () => true, tenantLimit: 50
  } });
  await w.tick();
  assert.equal(resolver.state.lastLimit, 50);
});
