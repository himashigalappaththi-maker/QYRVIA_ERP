'use strict';

/**
 * Phase 29 - Durable queue + dead-letter persistence against REAL PostgreSQL.
 * STRICT data-level boundary: no DDL / no CREATE ROLE / no DROP SCHEMA / no
 * migration at runtime; single existing role (qyrvia_test); fixtures cleaned up
 * with DELETE. Channel tables use FORCE RLS, so every statement runs inside a
 * tenant context (app.tenant_id).
 *
 * Proves the four durable-queue guarantees by reading rows back:
 *   - idempotency : partial-unique on PENDING => duplicate enqueue is deduped
 *   - concurrency : FOR UPDATE SKIP LOCKED => two concurrent claimers never collide
 *   - retry       : markFailed increments attempts; a FAILED key may be re-enqueued
 *   - DLQ + replay: dead-letter coalesces by (…, dedupe_generation); reprocess flag
 *
 * NOTE: the Phase 27.3 "AI Confirmation Queue" is IN-MEMORY (no persistence layer),
 * so it has nothing to validate against PostgreSQL; its retry/DLQ/replay/idempotency
 * are covered by aiConfirmation.test.js. The DB-backed queue validated here is the
 * channel sync queue. See the Phase 29 report.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  const { buildSyncQueueStoreDb, buildDeadLetterStoreDb } = require('../../src/channel-manager/persistence/dbStores');

  let pool, ctx;
  const withT = (fn) => H.withTenant(pool, ctx.tenantId, fn);
  const queue = (c) => buildSyncQueueStoreDb({ db: c });
  const dlq = (c) => buildDeadLetterStoreDb({ db: c });

  async function seedTenantProperty() {
    const tid = (await pool.query('SELECT gen_random_uuid() id')).rows[0].id;
    const pid = (await pool.query('SELECT gen_random_uuid() id')).rows[0].id;
    const code = 'QUE-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    await H.withTenant(pool, tid, async (c) => {
      await c.query('INSERT INTO tenants (id, code, name) VALUES ($1,$2,$3)', [tid, code, code]);
      await c.query('INSERT INTO properties (id, tenant_id, code, name, currency) VALUES ($1,$2,$3,$4,$5)', [pid, tid, code, code, 'LKR']);
    });
    return { tenantId: tid, propertyId: pid };
  }
  const job = (o) => Object.assign({ tenant_id: ctx.tenantId, property_id: ctx.propertyId, channel: 'BOOKING_COM', payload: {} }, o);

  before(async () => {
    pool = H.newPool(URL);
    const reg = await pool.query("SELECT to_regclass('public.channel_sync_queue_store') t");
    assert.ok(reg.rows[0].t, 'schema not provisioned: channel_sync_queue_store missing - migrate the target DB before running');
    ctx = await seedTenantProperty();
  });
  after(async () => {
    if (pool) {
      await H.withTenant(pool, ctx.tenantId, async (c) => {
        await c.query('DELETE FROM channel_sync_queue_store WHERE tenant_id=$1', [ctx.tenantId]);
        await c.query('DELETE FROM channel_dead_letter_store WHERE tenant_id=$1', [ctx.tenantId]);
        await c.query('DELETE FROM properties WHERE tenant_id=$1', [ctx.tenantId]);
        await c.query('DELETE FROM tenants WHERE id=$1', [ctx.tenantId]);
      });
      await pool.end();
    }
  });

  test('idempotency: a duplicate PENDING (reservation,action) is deduped', async () => {
    const a = await withT((c) => queue(c).enqueue(job({ reservation_id: 'R1', action: 'CREATE_BOOKING' })));
    const b = await withT((c) => queue(c).enqueue(job({ reservation_id: 'R1', action: 'CREATE_BOOKING' })));
    assert.equal(a.accepted, true);
    assert.equal(b.deduped, true);
    const n = await withT((c) => c.query(
      "SELECT count(*)::int n FROM channel_sync_queue_store WHERE tenant_id=$1 AND reservation_id='R1' AND action='CREATE_BOOKING'", [ctx.tenantId]).then((r) => r.rows[0].n));
    assert.equal(n, 1);
  });

  test('concurrency: two concurrent dequeues never claim the same job (SKIP LOCKED)', async () => {
    // control the starting state: clear any PENDING rows left by earlier tests so the
    // "no jobs remain" assertion is deterministic (data-level cleanup; no DDL).
    await withT((c) => c.query('DELETE FROM channel_sync_queue_store WHERE tenant_id=$1', [ctx.tenantId]));
    await withT((c) => queue(c).enqueue(job({ reservation_id: 'R-C1', action: 'CREATE_BOOKING' })));
    await withT((c) => queue(c).enqueue(job({ reservation_id: 'R-C2', action: 'CREATE_BOOKING' })));
    // two separate tenant transactions racing on the same PENDING set
    const [d1, d2] = await Promise.all([
      withT((c) => queue(c).dequeue()),
      withT((c) => queue(c).dequeue())
    ]);
    assert.ok(d1 && d2, 'both claimers got a job');
    assert.notEqual(d1.id, d2.id, 'distinct jobs claimed (no double-processing)');
    assert.equal(d1.status, 'PROCESSING');
    assert.equal(d2.status, 'PROCESSING');
    const third = await withT((c) => queue(c).dequeue());
    assert.equal(third, null, 'no PENDING jobs remain');
  });

  test('retry: markFailed increments attempts; a FAILED key may be re-enqueued', async () => {
    const e = await withT((c) => queue(c).enqueue(job({ reservation_id: 'R-RETRY', action: 'UPDATE_BOOKING' })));
    await withT((c) => queue(c).markProcessing(e.item.id));
    const f1 = await withT((c) => queue(c).markFailed(e.item.id));
    assert.equal(f1.status, 'FAILED');
    assert.equal(f1.attempts, 1);
    const re = await withT((c) => queue(c).enqueue(job({ reservation_id: 'R-RETRY', action: 'UPDATE_BOOKING' })));
    assert.equal(re.accepted, true, 'partial-unique only blocks PENDING, so a retry can re-enqueue');
  });

  test('DLQ: dead-letter coalesces by (tenant,reservation,action,generation)', async () => {
    const base = { tenant_id: ctx.tenantId, property_id: ctx.propertyId, reservation_id: 'R-DLQ', action: 'CANCEL_BOOKING', channel: 'AGODA' };
    const i1 = await withT((c) => dlq(c).insert(Object.assign({ last_error: 'boom-1', dedupe_generation: 0 }, base)));
    const i2 = await withT((c) => dlq(c).insert(Object.assign({ last_error: 'boom-2', dedupe_generation: 0 }, base)));
    assert.equal(i1.item.id, i2.item.id, 'same generation coalesces into one row');
    assert.equal(i2.item.attempts, 2, 'attempts incremented on coalesce');
    const i3 = await withT((c) => dlq(c).insert(Object.assign({ last_error: 'boom-3', dedupe_generation: 1 }, base)));
    assert.notEqual(i3.item.id, i1.item.id, 'a new generation is a distinct row');
    const n = await withT((c) => c.query("SELECT count(*)::int n FROM channel_dead_letter_store WHERE tenant_id=$1 AND reservation_id='R-DLQ'", [ctx.tenantId]).then((r) => r.rows[0].n));
    assert.equal(n, 2);
  });

  test('replay: requestReprocess flags a dead-letter for reprocessing', async () => {
    const ins = await withT((c) => dlq(c).insert({ tenant_id: ctx.tenantId, property_id: ctx.propertyId, reservation_id: 'R-REPLAY', action: 'CREATE_BOOKING', last_error: 'x', dedupe_generation: 0 }));
    const before = await withT((c) => dlq(c).get(ins.item.id));
    assert.equal(before.reprocess_requested, false);
    const after = await withT((c) => dlq(c).requestReprocess(ins.item.id));
    assert.equal(after.reprocess_requested, true);
  });

  test('queue status CHECK constraint rejects an unknown status value', async () => {
    await assert.rejects(
      () => withT((c) => c.query(
        `INSERT INTO channel_sync_queue_store (tenant_id, reservation_id, action, status)
         VALUES ($1,'R-BAD','CREATE_BOOKING','WAT')`, [ctx.tenantId])),
      (e) => H.isPgError(e, '23514'));
  });

  test('queue action CHECK constraint rejects an unknown action value', async () => {
    await assert.rejects(
      () => withT((c) => c.query(
        `INSERT INTO channel_sync_queue_store (tenant_id, reservation_id, action)
         VALUES ($1,'R-BAD2','TELEPORT')`, [ctx.tenantId])),
      (e) => H.isPgError(e, '23514'));
  });
}
