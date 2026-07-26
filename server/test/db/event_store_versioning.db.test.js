'use strict';

/**
 * Phase 63 P0-1 regression — canonical domain-event stream must persist EVERY
 * event of an aggregate, not just the first.
 *
 * Before the fix, `insertDomainEvent` hard-coded `event_version = 1`, so the
 * second event for the same (tenant, aggregate_type, aggregate_id) violated
 * `ux_event_store_version` and was swallowed by commandBus. The whole PMS
 * chain (reservation.created -> checked_in -> folio.posted -> payment.allocated
 * -> checked_out) is ONE aggregate stream, so only the first event survived.
 *
 * STRICT data-level boundary: no DDL, no CREATE ROLE, tenant-context (FORCE
 * RLS) only, DELETE cleanup.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  const { buildDomainEventWriter } = require('../../src/core/eventStoreWriter');

  let pool, ctx;
  const withT = (fn) => H.withTenant(pool, ctx.tenantId, fn);

  function ev(tenantId, propertyId, aggregateId, type) {
    return {
      event_id:       require('node:crypto').randomUUID(),
      event_type:     type,
      aggregate_type: 'reservation',
      aggregate_id:   aggregateId,
      tenant_id:      tenantId,
      property_id:    propertyId,
      actor_id:       null,
      request_id:     'req-' + Math.random().toString(36).slice(2, 10),
      payload:        { t: type },
      occurred_at:    new Date().toISOString()
    };
  }

  before(async () => {
    pool = H.tenantBoundPool
      ? H.newPool(URL)
      : H.newPool(URL);
    const tid = (await pool.query('SELECT gen_random_uuid() id')).rows[0].id;
    const pid = (await pool.query('SELECT gen_random_uuid() id')).rows[0].id;
    const code = 'ESV-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    await H.withTenant(pool, tid, async (c) => {
      await c.query('INSERT INTO tenants (id, code, name) VALUES ($1,$2,$3)', [tid, code, code]);
      await c.query('INSERT INTO properties (id, tenant_id, code, name, currency) VALUES ($1,$2,$3,$4,$5)', [pid, tid, code, code, 'LKR']);
    });
    ctx = { tenantId: tid, propertyId: pid };
  });

  after(async () => {
    if (!pool) return;
    try {
      await H.withTenant(pool, ctx.tenantId, async (c) => {
        await c.query('DELETE FROM event_store WHERE tenant_id = $1', [ctx.tenantId]);
        await c.query('DELETE FROM properties  WHERE tenant_id = $1', [ctx.tenantId]);
        await c.query('DELETE FROM tenants     WHERE id        = $1', [ctx.tenantId]);
      });
    } catch (_) { /* best effort cleanup */ }
    await pool.end();
  });

  test('P0-1: a full PMS aggregate chain persists EVERY event with monotonic versions', async () => {
    const aggId = 'RES-' + Math.random().toString(36).slice(2, 10);
    const chain = [
      'reservation.created',
      'reservation.checked_in',
      'folio.posted',
      'payment.allocated',
      'reservation.checked_out'
    ];

    await withT(async (c) => {
      const write = buildDomainEventWriter(c);
      for (const type of chain) {
        await write(ev(ctx.tenantId, ctx.propertyId, aggId, type));
      }
    });

    const rows = await withT(async (c) => (await c.query(
      `SELECT event_type, event_version FROM event_store
        WHERE tenant_id=$1 AND aggregate_type='reservation' AND aggregate_id=$2
        ORDER BY event_version ASC`, [ctx.tenantId, aggId])).rows);

    assert.equal(rows.length, chain.length,
      'every domain event in the chain must be persisted (was 1 before the fix)');
    assert.deepEqual(rows.map(r => r.event_version), [1, 2, 3, 4, 5],
      'event_version must be per-aggregate monotonic');
    assert.deepEqual(rows.map(r => r.event_type), chain, 'ordering must follow the chain');
  });

  test('P0-1: two aggregates version independently (no cross-stream interference)', async () => {
    const a = 'RES-A-' + Math.random().toString(36).slice(2, 8);
    const b = 'RES-B-' + Math.random().toString(36).slice(2, 8);

    await withT(async (c) => {
      const write = buildDomainEventWriter(c);
      await write(ev(ctx.tenantId, ctx.propertyId, a, 'reservation.created'));
      await write(ev(ctx.tenantId, ctx.propertyId, b, 'reservation.created'));
      await write(ev(ctx.tenantId, ctx.propertyId, a, 'reservation.checked_in'));
      await write(ev(ctx.tenantId, ctx.propertyId, b, 'reservation.checked_in'));
    });

    const va = await withT(async (c) => (await c.query(
      `SELECT event_version v FROM event_store WHERE tenant_id=$1 AND aggregate_id=$2 ORDER BY v`,
      [ctx.tenantId, a])).rows.map(r => r.v));
    const vb = await withT(async (c) => (await c.query(
      `SELECT event_version v FROM event_store WHERE tenant_id=$1 AND aggregate_id=$2 ORDER BY v`,
      [ctx.tenantId, b])).rows.map(r => r.v));

    assert.deepEqual(va, [1, 2]);
    assert.deepEqual(vb, [1, 2]);
  });

  test('P0-1: concurrent writers on the same aggregate all persist (retry resolves the race)', async () => {
    const aggId = 'RES-C-' + Math.random().toString(36).slice(2, 8);
    const N = 8;

    // Each concurrent writer gets its own connection+transaction so they truly
    // race on ux_event_store_version.
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => H.withTenant(pool, ctx.tenantId, async (c) => {
        const write = buildDomainEventWriter(c, { maxAttempts: 12 });
        return write(ev(ctx.tenantId, ctx.propertyId, aggId, 'folio.posted'));
      }))
    );

    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(rejected.length, 0,
      'no writer may be lost: ' + rejected.map(r => String(r.reason && r.reason.message)).join(' | '));

    const versions = await withT(async (c) => (await c.query(
      `SELECT event_version v FROM event_store
        WHERE tenant_id=$1 AND aggregate_id=$2 ORDER BY v`, [ctx.tenantId, aggId])).rows.map(r => r.v));

    assert.equal(versions.length, N, 'all concurrent events must be durable');
    assert.deepEqual(versions, Array.from({ length: N }, (_, i) => i + 1),
      'versions must be a gapless monotonic sequence');
  });

  test('P0-1: a replayed event_id (same PK) is NOT silently retried — it surfaces', async () => {
    const aggId = 'RES-D-' + Math.random().toString(36).slice(2, 8);
    const e = ev(ctx.tenantId, ctx.propertyId, aggId, 'reservation.created');

    await withT(async (c) => buildDomainEventWriter(c)(e));

    await assert.rejects(
      () => withT(async (c) => buildDomainEventWriter(c)(e)),
      (err) => err && err.code === '23505' && err.constraint !== 'ux_event_store_version',
      'a duplicate primary key must throw, not be absorbed by the version-race retry'
    );
  });
}
