'use strict';

/**
 * Phase 64 — tenant-bound unit of work (P0-11 foundation).
 *
 * These run without a database: a fake pool records every statement, so the
 * transaction/binding protocol itself is asserted. The real-PostgreSQL proof is
 * server/test/db/pms_stay_lifecycle.db.test.js and pms_transaction_rollback.db.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const uow = require('../src/db/tenantUnitOfWork');
const {
  runWithTenantTransaction, runWithTenantRead,
  getTenantClient, getTenantId, tenantQuery, requireTenantContext,
  hasTenantContext, ERR
} = uow;

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';

/**
 * Fake pool. Records statements, answers app_current_tenant() with whatever
 * set_config bound, and can be told to fail a specific statement.
 */
function fakePool(opts = {}) {
  const state = { statements: [], clients: [], released: [], destroyed: 0 };
  return {
    state,
    async connect() {
      let bound = null;
      const client = {
        id: state.clients.length,
        async query(text, params) {
          state.statements.push(text);
          if (opts.failOn && opts.failOn(text, params)) {
            const e = new Error('injected failure: ' + text);
            e.injected = true;
            throw e;
          }
          if (/set_config\('app\.tenant_id'/.test(text)) {
            bound = params && params[0];
            return { rows: [{ set_config: bound }] };
          }
          if (/app_current_tenant\(\)/.test(text)) {
            const reported = opts.reportTenant === undefined ? bound : opts.reportTenant;
            return { rows: [{ tid: reported }] };
          }
          return { rows: [], rowCount: 0 };
        },
        release(destroy) {
          state.released.push({ id: client.id, destroy: Boolean(destroy) });
          if (destroy) state.destroyed += 1;
        }
      };
      state.clients.push(client);
      return client;
    }
  };
}

// ---------------------------------------------------------------------------
// Binding protocol
// ---------------------------------------------------------------------------

test('a write unit BEGINs, binds app.tenant_id transaction-locally, verifies it, COMMITs', async () => {
  const pool = fakePool();
  const out = await runWithTenantTransaction(pool, T1, async () => 'done');

  assert.equal(out, 'done');
  const s = pool.state.statements;
  assert.equal(s[0], 'BEGIN');
  assert.match(s[1], /set_config\('app\.tenant_id', \$1, true\)/,
    'must be transaction-LOCAL so the binding cannot leak to the next borrower');
  assert.match(s[2], /app_current_tenant\(\)/, 'the bind must be PROVEN, not assumed');
  assert.equal(s[s.length - 1], 'COMMIT');
  assert.equal(pool.state.clients.length, 1, 'exactly one client is taken from the pool');
  assert.deepEqual(pool.state.released, [{ id: 0, destroy: false }]);
});

test('a read unit opens BEGIN TRANSACTION READ ONLY', async () => {
  const pool = fakePool();
  await runWithTenantRead(pool, T1, async () => null);
  assert.equal(pool.state.statements[0], 'BEGIN TRANSACTION READ ONLY');
  assert.equal(pool.state.statements[pool.state.statements.length - 1], 'COMMIT');
});

test('a tenantId that is not a UUID is rejected before any connection is taken', async () => {
  const pool = fakePool();
  for (const bad of [null, undefined, '', 'not-a-uuid', 42, T1 + 'x']) {
    await assert.rejects(
      () => runWithTenantTransaction(pool, bad, async () => null),
      (e) => e.code === ERR.TENANT_ID_INVALID
    );
  }
  assert.equal(pool.state.clients.length, 0, 'no client may be acquired for an invalid tenant');
});

test('a bind the database does not confirm aborts the unit (fail closed)', async () => {
  // The database reports a DIFFERENT tenant than we bound.
  const pool = fakePool({ reportTenant: T2 });
  await assert.rejects(
    () => runWithTenantTransaction(pool, T1, async () => 'must not run'),
    (e) => e.code === ERR.TENANT_BIND_FAILED
  );
  assert.ok(pool.state.statements.includes('ROLLBACK'));
});

test('a NULL app_current_tenant() aborts the unit', async () => {
  const pool = fakePool({ reportTenant: null });
  await assert.rejects(
    () => runWithTenantTransaction(pool, T1, async () => null),
    (e) => e.code === ERR.TENANT_BIND_FAILED
  );
});

// ---------------------------------------------------------------------------
// Context accessors — fail closed
// ---------------------------------------------------------------------------

test('outside a unit of work every accessor fails closed — there is NO pool fallback', async () => {
  assert.equal(hasTenantContext(), false);
  assert.equal(getTenantId(), null);
  assert.throws(() => getTenantClient(), (e) => e.code === ERR.TENANT_CONTEXT_REQUIRED);
  assert.throws(() => requireTenantContext('pmsRepo.findReservationById'),
    (e) => e.code === ERR.TENANT_CONTEXT_REQUIRED
        && /pmsRepo\.findReservationById/.test(e.message));
  await assert.rejects(async () => tenantQuery('SELECT 1'),
    (e) => e.code === ERR.TENANT_CONTEXT_REQUIRED);
});

test('the failure message names the caller and states that no fallback exists', () => {
  try { requireTenantContext('folioRepo.insertFolioLine'); assert.fail('should have thrown'); }
  catch (e) {
    assert.match(e.message, /folioRepo\.insertFolioLine/);
    assert.match(e.message, /no pool fallback by design/);
  }
});

test('inside a unit of work the accessors reach the bound client', async () => {
  const pool = fakePool();
  await runWithTenantTransaction(pool, T1, async (client, ctx) => {
    assert.equal(hasTenantContext(), true);
    assert.equal(getTenantId(), T1);
    assert.equal(getTenantClient(), client);
    assert.equal(ctx.mode, 'write');
    await tenantQuery('SELECT 1 FROM reservations');
  });
  assert.ok(pool.state.statements.includes('SELECT 1 FROM reservations'));
});

test('the context survives across await boundaries and nested async helpers', async () => {
  const pool = fakePool();
  async function deep() {
    await new Promise((r) => setImmediate(r));
    return getTenantId();
  }
  const seen = await runWithTenantTransaction(pool, T1, async () => {
    await new Promise((r) => setTimeout(r, 1));
    return deep();
  });
  assert.equal(seen, T1);
});

test('the context does NOT leak after the unit of work ends', async () => {
  const pool = fakePool();
  await runWithTenantTransaction(pool, T1, async () => null);
  assert.equal(hasTenantContext(), false);
  assert.equal(getTenantId(), null);
});

// ---------------------------------------------------------------------------
// Nesting
// ---------------------------------------------------------------------------

test('nesting the SAME tenant reuses the client and opens no second transaction', async () => {
  const pool = fakePool();
  await runWithTenantTransaction(pool, T1, async (outerClient) => {
    await runWithTenantTransaction(pool, T1, async (innerClient) => {
      assert.equal(innerClient, outerClient, 'the inner unit must reuse the outer client');
    });
  });

  assert.equal(pool.state.clients.length, 1, 'never acquire a second client');
  assert.equal(pool.state.statements.filter((s) => s === 'BEGIN').length, 1,
    'never open a nested independent transaction');
  assert.equal(pool.state.statements.filter((s) => s === 'COMMIT').length, 1,
    'the inner unit must not commit the outer transaction');
});

test('a nested READ inside a WRITE reuses the write transaction', async () => {
  const pool = fakePool();
  await runWithTenantTransaction(pool, T1, async (outerClient) => {
    await runWithTenantRead(pool, T1, async (innerClient) => {
      assert.equal(innerClient, outerClient);
    });
  });
  assert.equal(pool.state.statements.filter((s) => /BEGIN/.test(s)).length, 1);
});

test('nesting a DIFFERENT tenant throws TENANT_CONTEXT_MISMATCH', async () => {
  const pool = fakePool();
  await assert.rejects(
    () => runWithTenantTransaction(pool, T1, async () => {
      await runWithTenantTransaction(pool, T2, async () => 'cross-tenant');
    }),
    (e) => e.code === ERR.TENANT_CONTEXT_MISMATCH
  );
  assert.equal(pool.state.clients.length, 1, 'the mismatch must not acquire a second client');
  assert.ok(pool.state.statements.includes('ROLLBACK'), 'the outer unit rolls back');
});

test('a WRITE nested inside a READ ONLY unit is refused', async () => {
  const pool = fakePool();
  await assert.rejects(
    () => runWithTenantRead(pool, T1, async () => {
      await runWithTenantTransaction(pool, T1, async () => 'write attempt');
    }),
    (e) => e.code === ERR.TENANT_READ_ONLY
  );
});

// ---------------------------------------------------------------------------
// Rollback and release
// ---------------------------------------------------------------------------

test('a throwing callback rolls back the whole unit and rethrows the ORIGINAL error', async () => {
  const pool = fakePool();
  const boom = new Error('handler exploded');
  await assert.rejects(
    () => runWithTenantTransaction(pool, T1, async () => { throw boom; }),
    (e) => e === boom
  );
  assert.ok(pool.state.statements.includes('ROLLBACK'));
  assert.ok(!pool.state.statements.includes('COMMIT'));
  assert.deepEqual(pool.state.released, [{ id: 0, destroy: false }],
    'a cleanly rolled-back client is recycled, not destroyed');
});

test('a failing statement mid-unit rolls back everything before it', async () => {
  const pool = fakePool({ failOn: (t) => /INSERT INTO folios/.test(t) });
  await assert.rejects(
    () => runWithTenantTransaction(pool, T1, async () => {
      await tenantQuery('UPDATE reservations SET status=$1', ['CHECKED_IN']);
      await tenantQuery('UPDATE rooms SET status=$1', ['OCCUPIED']);
      await tenantQuery('INSERT INTO folios (id) VALUES ($1)', ['f1']);
    }),
    (e) => e.injected === true
  );
  const s = pool.state.statements;
  assert.ok(s.includes('UPDATE reservations SET status=$1'));
  assert.ok(s.includes('ROLLBACK'));
  assert.ok(!s.includes('COMMIT'), 'nothing may be committed');
});

test('a FAILED rollback is never silent — it is attached to the rethrown error and the client is destroyed', async () => {
  const pool = fakePool({ failOn: (t) => t === 'ROLLBACK' || /INSERT/.test(t) });
  await assert.rejects(
    () => runWithTenantTransaction(pool, T1, async () => {
      await tenantQuery('INSERT INTO folios (id) VALUES ($1)', ['f1']);
    }),
    (e) => e.injected === true && e.rollbackFailed === true && typeof e.rollbackError === 'string'
  );
  assert.equal(pool.state.destroyed, 1,
    'a client whose ROLLBACK failed must NOT be recycled into the pool');
});

test('a COMMIT failure rolls back and surfaces', async () => {
  const pool = fakePool({ failOn: (t) => t === 'COMMIT' });
  await assert.rejects(
    () => runWithTenantTransaction(pool, T1, async () => 'ok'),
    (e) => e.injected === true
  );
  assert.ok(pool.state.statements.includes('ROLLBACK'));
});

test('the client is always released, on success and on failure', async () => {
  const ok = fakePool();
  await runWithTenantTransaction(ok, T1, async () => null);
  assert.equal(ok.state.released.length, 1);

  const bad = fakePool();
  await assert.rejects(() => runWithTenantTransaction(bad, T1, async () => { throw new Error('x'); }));
  assert.equal(bad.state.released.length, 1);
});

test('a pool without connect() is rejected — there is no mock-pool bypass', async () => {
  await assert.rejects(
    () => runWithTenantTransaction({ query: async () => ({ rows: [] }) }, T1, async () => null),
    /pool with connect\(\) is required/
  );
});

test('tenantQuery never reads the tenant from its own parameters', async () => {
  // Passing a tenant id as a bind parameter must not create context.
  await assert.rejects(
    async () => tenantQuery('SELECT * FROM reservations WHERE tenant_id=$1', [T1]),
    (e) => e.code === ERR.TENANT_CONTEXT_REQUIRED
  );
});

test('two sequential units for different tenants each bind their own tenant', async () => {
  const pool = fakePool();
  await runWithTenantTransaction(pool, T1, async () => assert.equal(getTenantId(), T1));
  await runWithTenantTransaction(pool, T2, async () => assert.equal(getTenantId(), T2));
  assert.equal(pool.state.clients.length, 2);
});

test('concurrent units do not see each other\'s tenant (AsyncLocalStorage isolation)', async () => {
  const pool = fakePool();
  const seen = await Promise.all([
    runWithTenantTransaction(pool, T1, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getTenantId();
    }),
    runWithTenantTransaction(pool, T2, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getTenantId();
    })
  ]);
  assert.deepEqual(seen, [T1, T2]);
});
