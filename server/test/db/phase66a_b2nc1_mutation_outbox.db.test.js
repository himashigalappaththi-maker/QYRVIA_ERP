'use strict';

/**
 * Phase 66A-B2N-C1 — atomic ARI mutation plus outbox event production,
 * through the REAL committed production code path against REAL PostgreSQL,
 * with migration 0087 already applied.
 *
 * STRICT data-level boundary, identical to every sibling B2H-B2N-B DB test:
 * no DDL (no CREATE/ALTER/DROP/TRUNCATE/GRANT/REVOKE), no migration run, no
 * freshSchema, no psql, no bootstrap, no role/ownership/RLS change, one
 * existing non-superuser role (qyrvia_test). Every fixture identifier is
 * freshly generated per run, and cleanup deletes ONLY rows this file created,
 * scoped by its own tenant ids, in an after() hook that runs even when an
 * assertion fails. Zero network activity: only the ARI store, the ARI outbox
 * and the booking-engine adjuster are exercised — no adapter, transport or
 * provider code is reachable from any of them.
 *
 * Connection: process.env.TEST_DATABASE_URL ONLY. There is deliberately no
 * fallback to DATABASE_URL and no PG* variable is consulted; the guarded
 * PowerShell launcher validates the full nine-clause target contract before
 * this file is ever spawned. If TEST_DATABASE_URL is absent this file fails
 * closed before opening any connection.
 *
 * RESTRICTION-RULE DEFERRAL (case I): putRestrictionRule intentionally emits
 * NO outbox event in B2N-C1. ari_restriction_rule.room_type_id and
 * rate_plan_id are both nullable while the canonical outbox identity requires
 * a non-empty roomTypeId that also participates in the dedupe key, so a safe
 * restriction-event identity is designed in B2N-C2. This file asserts the
 * absence of that event so the deferral cannot regress into silent emission.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./_dbHarness');

const URL = process.env.TEST_DATABASE_URL || null;

if (!URL) {
  // Fail closed — never skip silently, never fall back to another variable.
  test('TEST_DATABASE_URL is required for this guarded DB test — failing closed', () => {
    assert.fail('TEST_DATABASE_URL is not set; refusing to connect');
  });
} else {
  const {
    withTenantAriUnit,
    withTenantAriStore,
    ARI_CONFIG_EFFECTIVE_FROM,
    ARI_CONFIG_EFFECTIVE_TO
  } = require('../../src/ari/store/tenantAriStore');
  const { buildAriDedupeKey } = require('../../src/ari/outbox/ariOutboxStore');
  const { buildAriInventoryAdjuster } = require('../../src/booking-engine/ariInventoryAdjuster');
  const { buildAriHandlers } = require('../../src/ari/api/ari.handlers');

  let pool, tenantA, tenantB, handlers, adjuster;

  const RT = 'rt-b2nc1';
  const RP = 'rp-b2nc1';
  const D1 = '2026-09-01';
  const D2 = '2026-09-02';
  const D3 = '2026-09-03';
  const D4 = '2026-09-04';

  // ---- fixtures ----------------------------------------------------------

  async function seedTenantProperty(code) {
    const tenantId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    await H.withTenant(pool, tenantId, async (c) => {
      await c.query('INSERT INTO tenants (id, code, name) VALUES ($1,$2,$3)', [tenantId, code, code]);
      await c.query(
        'INSERT INTO properties (id, tenant_id, code, name, currency) VALUES ($1,$2,$3,$4,$5)',
        [propertyId, tenantId, code, code, 'LKR']
      );
    });
    return { tenantId, propertyId };
  }

  /** Data-level inventory seed for the dates this file mutates. */
  async function seedInventory(tenant, dates, physical = 10, sold = 5) {
    await H.withTenant(pool, tenant.tenantId, async (c) => {
      for (const date of dates) {
        await c.query(
          `INSERT INTO ari_inventory_grid
             (tenant_id, property_id, room_type_id, date, physical, sold, blocked)
           VALUES ($1,$2,$3,$4,$5,$6,0)
           ON CONFLICT (tenant_id, property_id, room_type_id, date) DO NOTHING`,
          [tenant.tenantId, tenant.propertyId, RT, date, physical, sold]
        );
      }
    });
  }

  async function events(tenant, where = '', params = []) {
    return H.withTenant(pool, tenant.tenantId, async (c) => {
      const r = await c.query(
        'SELECT * FROM ari_outbox_store WHERE tenant_id=$1 ' + where + ' ORDER BY created_at, effective_from',
        [tenant.tenantId].concat(params)
      );
      return r.rows;
    });
  }

  async function cell(tenant, date) {
    return H.withTenant(pool, tenant.tenantId, async (c) => {
      const r = await c.query(
        'SELECT * FROM ari_inventory_grid WHERE tenant_id=$1 AND property_id=$2 AND room_type_id=$3 AND date=$4',
        [tenant.tenantId, tenant.propertyId, RT, date]
      );
      return r.rows[0] || null;
    });
  }

  async function clearEvents(tenant) {
    await H.withTenant(pool, tenant.tenantId, (c) =>
      c.query('DELETE FROM ari_outbox_store WHERE tenant_id=$1', [tenant.tenantId]));
  }

  async function cleanupTenant(tenant) {
    if (!tenant) return;
    // Scoped to this file's own generated tenant id only — never a broad
    // unqualified delete, and never touching pre-existing data.
    await H.withTenant(pool, tenant.tenantId, async (c) => {
      await c.query('DELETE FROM ari_outbox_store WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM ari_inventory_grid WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM ari_restriction_rule WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM ari_rate_plan WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM ari_room_type WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM properties WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM tenants WHERE id=$1', [tenant.tenantId]);
    });
  }

  /**
   * node-pg returns DATE columns as a JS Date at LOCAL midnight; format with
   * LOCAL components (never toISOString, which would shift the day in a
   * non-UTC timezone). Mirrors src/ari/store/dbStore.js's own iso().
   */
  function isoOf(d) {
    if (d instanceof Date) {
      return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    }
    return String(d).slice(0, 10);
  }

  function res() {
    return {
      _status: 200, _json: null,
      status(s) { this._status = s; return this; },
      json(b) { this._json = b; return this; }
    };
  }
  const ctxOf = (t) => ({ tenantId: t.tenantId, propertyId: t.propertyId, requestId: 'db-test' });

  before(async () => {
    pool = H.newPool(URL);
    tenantA = await seedTenantProperty('C1A' + crypto.randomUUID().slice(0, 6));
    tenantB = await seedTenantProperty('C1B' + crypto.randomUUID().slice(0, 6));
    handlers = buildAriHandlers({ pool });
    adjuster = buildAriInventoryAdjuster({
      withAriStore: (tenantId, cb) => withTenantAriStore(pool, tenantId, cb)
    });
  });

  after(async () => {
    try {
      await cleanupTenant(tenantA);
      await cleanupTenant(tenantB);
    } finally {
      if (pool) await pool.end();
    }
  });

  // ---- A. successful inventory mutation ----------------------------------

  test('A. a committed adjustSold leaves the inventory mutation AND exactly one canonical INVENTORY_CHANGED event', async () => {
    await seedInventory(tenantA, [D1]);
    await clearEvents(tenantA);
    const before = await cell(tenantA, D1);

    await adjuster.adjustSold({
      tenantId: tenantA.tenantId, propertyId: tenantA.propertyId, roomTypeId: RT,
      arrival: D1, departure: D2, delta: 1
    });

    const after = await cell(tenantA, D1);
    assert.equal(after.sold, before.sold + 1, 'the authoritative mutation committed');

    const rows = await events(tenantA);
    assert.equal(rows.length, 1, 'exactly one event');
    const e = rows[0];
    assert.equal(e.event_type, 'INVENTORY_CHANGED');
    assert.equal(e.resource_kind, 'INVENTORY');
    assert.equal(e.rate_plan_id, null);
    assert.equal(e.room_type_id, RT);
    assert.equal(e.property_id, tenantA.propertyId);
    assert.equal(isoOf(e.effective_from), D1, 'effectiveFrom is the mutated night');
    assert.equal(isoOf(e.effective_to), D2, 'effectiveTo is the next calendar date');
    assert.equal(e.source_version, after.version, 'sourceVersion is the authoritative returned version');
    assert.equal(e.status, 'PENDING');
    assert.equal(e.dedupe_key, buildAriDedupeKey({
      eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY', roomTypeId: RT,
      ratePlanId: null, effectiveFrom: D1, effectiveTo: D2, sourceVersion: after.version
    }), 'the dedupe key is the canonical B2N-B identity');
    assert.match(e.dedupe_key, /^aob:v1:[0-9a-f]{64}$/);
  });

  // ---- B. enqueue failure rolls the whole unit back -----------------------

  test('B. an enqueue failure inside the shared unit leaves NO mutation and NO event committed', async () => {
    await seedInventory(tenantA, [D1]);
    await clearEvents(tenantA);
    const before = await cell(tenantA, D1);

    // Data-level failure only: an invalid sourceVersion is rejected by the
    // outbox's own validation INSIDE the unit, after the authoritative
    // mutation has already executed on the same client. No DDL, no schema,
    // RLS, grant or role change is used to manufacture it.
    await assert.rejects(() => withTenantAriUnit(pool, tenantA.tenantId, async ({ ariStore, outbox }) => {
      await ariStore.adjustSold({
        tenant_id: tenantA.tenantId, propertyId: tenantA.propertyId,
        roomTypeId: RT, date: D1, delta: 1
      });
      await outbox.enqueue({
        tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
        eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY',
        roomTypeId: RT, ratePlanId: null,
        effectiveFrom: D1, effectiveTo: D2,
        sourceVersion: 0, // invalid — must be a positive integer
        payload: {}
      });
    }));

    const after = await cell(tenantA, D1);
    assert.equal(after.sold, before.sold, 'the authoritative mutation was rolled back');
    assert.equal(after.version, before.version, 'no version bump survived');
    assert.equal((await events(tenantA)).length, 0, 'no event was committed');
  });

  // ---- C. idempotent logical event ---------------------------------------

  test('C. repeating the identical logical event yields exactly ONE outbox row', async () => {
    await seedInventory(tenantA, [D1]);
    await clearEvents(tenantA);
    const version = (await cell(tenantA, D1)).version;

    const enqueueSame = () => withTenantAriUnit(pool, tenantA.tenantId, ({ outbox }) => outbox.enqueue({
      tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
      eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY',
      roomTypeId: RT, ratePlanId: null,
      effectiveFrom: D1, effectiveTo: D2,
      sourceVersion: version, payload: { sold: 1 }
    }));

    const first = await enqueueSame();
    const second = await enqueueSame();
    assert.equal(first.accepted, true);
    assert.equal(second.accepted, false);
    assert.equal(second.deduped, true);
    assert.equal(second.existing.id, first.row.id);

    const rows = await events(tenantA);
    assert.equal(rows.length, 1, 'one logical row for the identical identity');
  });

  // ---- D. a later authoritative version is a distinct event ---------------

  test('D. a legitimate later version is accepted as a second distinct outbox row', async () => {
    await seedInventory(tenantA, [D1]);
    await clearEvents(tenantA);

    await adjuster.adjustSold({
      tenantId: tenantA.tenantId, propertyId: tenantA.propertyId, roomTypeId: RT,
      arrival: D1, departure: D2, delta: 1
    });
    await adjuster.adjustSold({
      tenantId: tenantA.tenantId, propertyId: tenantA.propertyId, roomTypeId: RT,
      arrival: D1, departure: D2, delta: 1
    });

    const rows = await events(tenantA);
    assert.equal(rows.length, 2, 'the later version produced a second row');
    assert.notEqual(rows[0].dedupe_key, rows[1].dedupe_key);
    assert.notEqual(rows[0].source_version, rows[1].source_version);
  });

  // ---- E. multi-night atomicity ------------------------------------------

  test('E1. a 3-night adjustment commits 3 inventory changes AND 3 matching events', async () => {
    await seedInventory(tenantA, [D1, D2, D3]);
    await clearEvents(tenantA);
    const before = [await cell(tenantA, D1), await cell(tenantA, D2), await cell(tenantA, D3)];

    await adjuster.adjustSold({
      tenantId: tenantA.tenantId, propertyId: tenantA.propertyId, roomTypeId: RT,
      arrival: D1, departure: D4, delta: 1
    });

    for (let i = 0; i < 3; i += 1) {
      const d = [D1, D2, D3][i];
      assert.equal((await cell(tenantA, d)).sold, before[i].sold + 1, 'night ' + d + ' committed');
    }
    const rows = await events(tenantA);
    assert.equal(rows.length, 3, 'one event per night');
    assert.deepEqual(rows.map((r) => isoOf(r.effective_from)).sort(), [D1, D2, D3]);
    assert.ok(rows.every((r) => r.event_type === 'INVENTORY_CHANGED' && r.rate_plan_id === null));
  });

  test('E2. a failure midway through a multi-night adjustment leaves NO night and NO event committed', async () => {
    await seedInventory(tenantA, [D1, D2, D3]);
    await clearEvents(tenantA);
    const before = [await cell(tenantA, D1), await cell(tenantA, D2), await cell(tenantA, D3)];

    // Night 1 mutates and emits successfully; night 2 mutates and then its
    // enqueue fails (invalid sourceVersion — a data-level rejection, no DDL);
    // night 3 must never run. The single unit must unwind all of it.
    await assert.rejects(() => withTenantAriUnit(pool, tenantA.tenantId, async ({ ariStore, outbox }) => {
      // night 1 mutates + emits successfully
      const n1 = await ariStore.adjustSold({
        tenant_id: tenantA.tenantId, propertyId: tenantA.propertyId, roomTypeId: RT, date: D1, delta: 1
      });
      await outbox.enqueue({
        tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
        eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY',
        roomTypeId: RT, ratePlanId: null, effectiveFrom: D1, effectiveTo: D2,
        sourceVersion: n1.version, payload: { sold: n1.sold }
      });
      // night 2 mutates, then its enqueue fails — the whole unit must unwind
      await ariStore.adjustSold({
        tenant_id: tenantA.tenantId, propertyId: tenantA.propertyId, roomTypeId: RT, date: D2, delta: 1
      });
      await outbox.enqueue({
        tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
        eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY',
        roomTypeId: RT, ratePlanId: null, effectiveFrom: D2, effectiveTo: D3,
        sourceVersion: -1, // invalid → throws inside the unit
        payload: {}
      });
      // night 3 must never be reached
      await ariStore.adjustSold({
        tenant_id: tenantA.tenantId, propertyId: tenantA.propertyId, roomTypeId: RT, date: D3, delta: 1
      });
    }));

    for (let i = 0; i < 3; i += 1) {
      const d = [D1, D2, D3][i];
      const now = await cell(tenantA, d);
      assert.equal(now.sold, before[i].sold, 'night ' + d + ' was rolled back');
      assert.equal(now.version, before[i].version, 'night ' + d + ' version unchanged');
    }
    assert.equal((await events(tenantA)).length, 0, 'the earlier night\'s event rolled back too');
  });

  // ---- F. wrong property / tenant binding --------------------------------

  test('F. an event referencing another tenant\'s property is rejected and rolls the mutation back', async () => {
    await seedInventory(tenantA, [D1]);
    await clearEvents(tenantA);
    const before = await cell(tenantA, D1);

    await assert.rejects(() => withTenantAriUnit(pool, tenantA.tenantId, async ({ ariStore, outbox }) => {
      const changed = await ariStore.adjustSold({
        tenant_id: tenantA.tenantId, propertyId: tenantA.propertyId,
        roomTypeId: RT, date: D1, delta: 1
      });
      await outbox.enqueue({
        tenantId: tenantA.tenantId,
        propertyId: tenantB.propertyId, // belongs to tenant B — composite FK must reject
        eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY',
        roomTypeId: RT, ratePlanId: null, effectiveFrom: D1, effectiveTo: D2,
        sourceVersion: changed.version, payload: {}
      });
    }));

    const after = await cell(tenantA, D1);
    assert.equal(after.sold, before.sold, 'the authoritative mutation rolled back');
    assert.equal((await events(tenantA)).length, 0, 'no event for tenant A');
    assert.equal((await events(tenantB)).length, 0, 'and none leaked to tenant B');
  });

  // ---- G. room-type event -------------------------------------------------

  test('G. putRoomType returns its DB version and emits AVAILABILITY_CHANGED over the sentinel window', async () => {
    await clearEvents(tenantA);
    const r = res();
    await handlers.upsertRoomType(
      { ctx: ctxOf(tenantA), body: { roomTypeId: RT, code: 'STD', name: 'Standard', totalUnits: 12 } },
      r
    );
    assert.equal(r._status, 200);
    assert.ok(Number.isInteger(r._json.data.version), 'the authoritative version is returned');

    const rows = await events(tenantA);
    assert.equal(rows.length, 1);
    const e = rows[0];
    assert.equal(e.event_type, 'AVAILABILITY_CHANGED');
    assert.equal(e.resource_kind, 'AVAILABILITY');
    assert.equal(e.rate_plan_id, null);
    assert.equal(e.room_type_id, RT);
    assert.equal(isoOf(e.effective_from), ARI_CONFIG_EFFECTIVE_FROM);
    assert.equal(isoOf(e.effective_to), ARI_CONFIG_EFFECTIVE_TO);
    assert.equal(e.source_version, r._json.data.version);
  });

  // ---- H. rate-plan event -------------------------------------------------

  test('H. putRatePlan returns its DB version and emits RATE_CHANGED carrying the rate plan', async () => {
    await clearEvents(tenantA);
    const r = res();
    await handlers.upsertRatePlan(
      { ctx: ctxOf(tenantA), body: { ratePlanId: RP, roomTypeId: RT, code: 'BAR', name: 'Best Available', currency: 'USD', baseRate: 150 } },
      r
    );
    assert.equal(r._status, 200);
    assert.ok(Number.isInteger(r._json.data.version));

    const rows = await events(tenantA);
    assert.equal(rows.length, 1);
    const e = rows[0];
    assert.equal(e.event_type, 'RATE_CHANGED');
    assert.equal(e.resource_kind, 'RATE');
    assert.equal(e.rate_plan_id, RP);
    assert.equal(isoOf(e.effective_from), ARI_CONFIG_EFFECTIVE_FROM);
    assert.equal(isoOf(e.effective_to), ARI_CONFIG_EFFECTIVE_TO);
    assert.equal(e.source_version, r._json.data.version);
  });

  // ---- I. restriction-rule deferral --------------------------------------

  test('I. putRestrictionRule mutates and returns its DB version but emits NO event (B2N-C2 deferral)', async () => {
    await clearEvents(tenantA);
    const r = res();
    await handlers.upsertRestrictionRule(
      { ctx: ctxOf(tenantA), body: { id: 'rr-b2nc1', level: 'property', date_from: D1, date_to: D4, minLos: 2 } },
      r
    );
    assert.equal(r._status, 200);
    assert.ok(Number.isInteger(r._json.data.version), 'the authoritative version is returned additively');

    const persisted = await H.withTenant(pool, tenantA.tenantId, async (c) => {
      const q = await c.query('SELECT version FROM ari_restriction_rule WHERE tenant_id=$1 AND id=$2', [tenantA.tenantId, 'rr-b2nc1']);
      return q.rows[0] || null;
    });
    assert.ok(persisted, 'the authoritative mutation committed');
    assert.equal(persisted.version, r._json.data.version);
    assert.equal((await events(tenantA)).length, 0, 'restriction events are deferred to B2N-C2');
  });

  // ---- J. isolation and legacy absence -----------------------------------

  test('J1. RLS and FORCE RLS remain enabled on ari_outbox_store', async () => {
    const r = await pool.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='ari_outbox_store'"
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].relrowsecurity, true);
    assert.equal(r.rows[0].relforcerowsecurity, true);
  });

  test('J2. tenant A cannot see tenant B outbox rows', async () => {
    await clearEvents(tenantA);
    await clearEvents(tenantB);
    await seedInventory(tenantB, [D1]);
    await adjuster.adjustSold({
      tenantId: tenantB.tenantId, propertyId: tenantB.propertyId, roomTypeId: RT,
      arrival: D1, departure: D2, delta: 1
    });
    assert.equal((await events(tenantB)).length, 1, 'tenant B has its own event');

    const seenByA = await H.withTenant(pool, tenantA.tenantId, async (c) => {
      const q = await c.query('SELECT count(*)::int AS n FROM ari_outbox_store WHERE property_id=$1', [tenantB.propertyId]);
      return q.rows[0].n;
    });
    assert.equal(seenByA, 0, 'tenant A sees zero of tenant B rows');
  });

  test('J3. no channel_sync_queue_store row was created by any B2N-C1 operation', async () => {
    // Counted INSIDE each tenant's own RLS context — a bare-pool count would
    // be vacuously zero on this FORCE RLS table and prove nothing.
    for (const t of [tenantA, tenantB]) {
      const n = await H.withTenant(pool, t.tenantId, async (c) => {
        const q = await c.query('SELECT count(*)::int AS n FROM channel_sync_queue_store WHERE tenant_id=$1', [t.tenantId]);
        return q.rows[0].n;
      });
      assert.equal(n, 0, 'no reservation-queue row for this tenant');
    }
  });

  test('J4. ari_outbox_store still has no reservation_id column', async () => {
    const r = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ari_outbox_store' AND column_name='reservation_id'"
    );
    assert.equal(r.rows.length, 0);
  });
}
