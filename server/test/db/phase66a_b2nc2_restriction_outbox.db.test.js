'use strict';

/**
 * Phase 66A-B2N-C2 — collision-safe restriction-rule outbox events (aob:v2)
 * through the REAL committed production code path against REAL PostgreSQL,
 * with migrations 0087 AND 0088 applied.
 *
 * STRICT data-level boundary, identical to every sibling B2H-B2N-C1 DB test:
 * no DDL (no CREATE/ALTER/DROP/TRUNCATE/GRANT/REVOKE), no migration run, no
 * freshSchema, no psql, no bootstrap, no role/ownership/RLS change, one
 * existing non-superuser role. Every fixture identifier is freshly generated
 * per run; cleanup deletes ONLY rows this file created, scoped by its own
 * tenant ids, in an after() hook that runs even when an assertion fails.
 * Zero network activity.
 *
 * Connection: process.env.TEST_DATABASE_URL ONLY — no fallback to
 * DATABASE_URL, no PG* variable, no server/.env read. Fails closed before
 * connecting when it is absent.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./_dbHarness');

const URL = process.env.TEST_DATABASE_URL || null;

if (!URL) {
  test('TEST_DATABASE_URL is required for this guarded DB test — failing closed', () => {
    assert.fail('TEST_DATABASE_URL is not set; refusing to connect');
  });
} else {
  const { withTenantAriUnit } = require('../../src/ari/store/tenantAriStore');
  const { buildAriRestrictionDedupeKey } = require('../../src/ari/outbox/ariOutboxStore');
  const { buildAriHandlers } = require('../../src/ari/api/ari.handlers');

  let pool, tenantA, tenantB, handlers;

  const D1 = '2026-10-01';
  const D2 = '2026-10-31';

  function isoOf(d) {
    if (d instanceof Date) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    return String(d).slice(0, 10);
  }

  async function seedTenantProperty(code) {
    const tenantId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    await H.withTenant(pool, tenantId, async (c) => {
      await c.query('INSERT INTO tenants (id, code, name) VALUES ($1,$2,$3)', [tenantId, code, code]);
      await c.query('INSERT INTO properties (id, tenant_id, code, name, currency) VALUES ($1,$2,$3,$4,$5)',
        [propertyId, tenantId, code, code, 'LKR']);
    });
    return { tenantId, propertyId };
  }

  async function events(tenant, extra = '', params = []) {
    return H.withTenant(pool, tenant.tenantId, async (c) => {
      const r = await c.query(
        'SELECT * FROM ari_outbox_store WHERE tenant_id=$1 ' + extra + ' ORDER BY created_at, dedupe_key',
        [tenant.tenantId].concat(params));
      return r.rows;
    });
  }
  async function clearEvents(tenant) {
    await H.withTenant(pool, tenant.tenantId, (c) =>
      c.query('DELETE FROM ari_outbox_store WHERE tenant_id=$1', [tenant.tenantId]));
  }
  async function rule(tenant, id) {
    return H.withTenant(pool, tenant.tenantId, async (c) => {
      const r = await c.query('SELECT * FROM ari_restriction_rule WHERE tenant_id=$1 AND id=$2', [tenant.tenantId, id]);
      return r.rows[0] || null;
    });
  }

  async function cleanupTenant(tenant) {
    if (!tenant) return;
    await H.withTenant(pool, tenant.tenantId, async (c) => {
      await c.query('DELETE FROM ari_outbox_store WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM ari_restriction_rule WHERE tenant_id=$1', [tenant.tenantId]);
      // Case I seeds an ari_inventory_grid cell; its property_id references
      // properties(id), so it must go before the property row or the DELETE
      // below raises 23503 (ari_inventory_grid_property_id_fkey) inside the
      // after() hook.
      await c.query('DELETE FROM ari_inventory_grid WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM properties WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM tenants WHERE id=$1', [tenant.tenantId]);
    });
  }

  function res() {
    return { _status: 200, _json: null, status(s) { this._status = s; return this; }, json(b) { this._json = b; return this; } };
  }
  const ctxOf = (t) => ({ tenantId: t.tenantId, propertyId: t.propertyId, requestId: 'db-test' });
  const ruleBody = (id, over = {}) => Object.assign({
    id, level: 'property', date_from: D1, date_to: D2, minLos: 2
  }, over);

  before(async () => {
    pool = H.newPool(URL);
    tenantA = await seedTenantProperty('C2A' + crypto.randomUUID().slice(0, 6));
    tenantB = await seedTenantProperty('C2B' + crypto.randomUUID().slice(0, 6));
    handlers = buildAriHandlers({ pool });
  });

  after(async () => {
    try {
      await cleanupTenant(tenantA);
      await cleanupTenant(tenantB);
    } finally {
      if (pool) await pool.end();
    }
  });

  // ---- A. all four scopes commit atomically, nulls stay real NULLs --------

  test('A. all four restriction scopes commit the rule AND its event atomically, with real SQL NULLs', async () => {
    await clearEvents(tenantA);
    const scopes = [
      ['prop-wide', {}],
      ['rt-only',   { roomTypeId: 'rt1' }],
      ['rp-only',   { ratePlanId: 'rp1' }],
      ['combined',  { roomTypeId: 'rt1', ratePlanId: 'rp1' }]
    ];
    for (const [id, over] of scopes) {
      const r = res();
      await handlers.upsertRestrictionRule({ ctx: ctxOf(tenantA), body: ruleBody(id, over) }, r);
      assert.equal(r._status, 200, id + ' committed');
      assert.ok(await rule(tenantA, id), id + ' rule persisted');
    }

    const rows = await events(tenantA);
    assert.equal(rows.length, 4, 'one event per scope');
    for (const row of rows) {
      assert.equal(row.event_type, 'AVAILABILITY_CHANGED');
      assert.equal(row.resource_kind, 'AVAILABILITY');
      assert.match(row.dedupe_key, /^aob:v2:[0-9a-f]{64}$/);
      assert.ok(row.restriction_rule_id, 'the rule identity is stored');
      assert.equal(isoOf(row.effective_from), D1);
      assert.equal(isoOf(row.effective_to), D2);
    }
    const byId = Object.fromEntries(rows.map((r) => [r.restriction_rule_id, r]));
    assert.equal(byId['prop-wide'].room_type_id, null, 'a property-wide rule stores a real NULL room type');
    assert.equal(byId['prop-wide'].rate_plan_id, null);
    assert.equal(byId['rp-only'].room_type_id, null, 'a rate-plan-only rule stores a real NULL room type');
    assert.equal(byId['rp-only'].rate_plan_id, 'rp1', 'and carries its rate plan on an AVAILABILITY event');
    assert.equal(byId['rt-only'].room_type_id, 'rt1');
    assert.equal(byId['combined'].rate_plan_id, 'rp1');
    assert.equal(new Set(rows.map((r) => r.dedupe_key)).size, 4, 'all four identities are distinct');
  });

  // ---- B. two distinct rules, identical scope and dates -------------------

  test('B. two DIFFERENT rule ids over identical scope and dates produce TWO events', async () => {
    await clearEvents(tenantA);
    for (const id of ['dup-a', 'dup-b']) {
      const r = res();
      await handlers.upsertRestrictionRule({ ctx: ctxOf(tenantA), body: ruleBody(id) }, r);
      assert.equal(r._status, 200);
    }
    const rows = await events(tenantA, "AND restriction_rule_id LIKE 'dup-%'");
    assert.equal(rows.length, 2, 'v1 would have collapsed these into one');
    assert.equal(new Set(rows.map((r) => r.dedupe_key)).size, 2);
  });

  // ---- C. identical retry preserves version and deduplicates -------------

  test('C. an identical retry preserves version and updated_at and yields ONE event', async () => {
    await clearEvents(tenantA);
    const first = res();
    await handlers.upsertRestrictionRule({ ctx: ctxOf(tenantA), body: ruleBody('retry-1') }, first);
    const afterFirst = await rule(tenantA, 'retry-1');

    const again = res();
    await handlers.upsertRestrictionRule({ ctx: ctxOf(tenantA), body: ruleBody('retry-1') }, again);
    const afterRetry = await rule(tenantA, 'retry-1');

    assert.equal(afterRetry.version, afterFirst.version, 'the identical retry did NOT mint a new version');
    assert.equal(String(afterRetry.updated_at), String(afterFirst.updated_at), 'updated_at preserved');
    assert.equal(again._json.data.version, afterFirst.version, 'the response reports the preserved version');
    const rows = await events(tenantA, "AND restriction_rule_id='retry-1'");
    assert.equal(rows.length, 1, 'exactly one logical event');
  });

  // ---- D. a real value change bumps version and emits a second event -----

  test('D. a genuine value change increments version exactly once and produces a SECOND event', async () => {
    await clearEvents(tenantA);
    await handlers.upsertRestrictionRule({ ctx: ctxOf(tenantA), body: ruleBody('chg-1', { minLos: 2 }) }, res());
    const v1 = (await rule(tenantA, 'chg-1')).version;
    await handlers.upsertRestrictionRule({ ctx: ctxOf(tenantA), body: ruleBody('chg-1', { minLos: 5 }) }, res());
    const v2 = (await rule(tenantA, 'chg-1')).version;

    assert.equal(v2, v1 + 1, 'incremented exactly once');
    const rows = await events(tenantA, "AND restriction_rule_id='chg-1'");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.source_version).sort((a, b) => a - b), [v1, v2]);
    assert.equal(new Set(rows.map((r) => r.dedupe_key)).size, 2);
  });

  // ---- E. concurrent identical requests -----------------------------------

  test('E. concurrent identical requests produce exactly ONE logical event', async () => {
    await clearEvents(tenantA);
    await Promise.all([
      handlers.upsertRestrictionRule({ ctx: ctxOf(tenantA), body: ruleBody('conc-1') }, res()),
      handlers.upsertRestrictionRule({ ctx: ctxOf(tenantA), body: ruleBody('conc-1') }, res())
    ]);
    const rows = await events(tenantA, "AND restriction_rule_id='conc-1'");
    assert.equal(rows.length, 1);
  });

  // ---- F. request-only scope change must not misdescribe persisted scope --

  test('F. resubmitting an existing id with different request scope keeps and reports the PERSISTED scope', async () => {
    await clearEvents(tenantA);
    await handlers.upsertRestrictionRule({ ctx: ctxOf(tenantA), body: ruleBody('scope-1', { roomTypeId: 'rt-original' }) }, res());
    const original = await rule(tenantA, 'scope-1');

    const second = res();
    await handlers.upsertRestrictionRule({
      ctx: ctxOf(tenantA),
      body: ruleBody('scope-1', { roomTypeId: 'rt-DIFFERENT', level: 'channel', date_from: '2026-11-01', date_to: '2026-11-30', minLos: 7 })
    }, second);
    const after = await rule(tenantA, 'scope-1');

    assert.equal(after.room_type_id, original.room_type_id, 'persisted scope unchanged by the conflict path');
    assert.equal(after.level, original.level);
    assert.equal(isoOf(after.date_from), isoOf(original.date_from));
    assert.equal(second._json.data.roomTypeId, original.room_type_id, 'the response reports persisted scope');

    const rows = await events(tenantA, "AND restriction_rule_id='scope-1'");
    for (const row of rows) {
      assert.equal(row.room_type_id, original.room_type_id, 'no event describes the request-only scope');
      assert.notEqual(row.room_type_id, 'rt-DIFFERENT');
    }
    const latest = rows.find((r) => r.source_version === after.version);
    assert.equal(latest.dedupe_key, buildAriRestrictionDedupeKey({
      restrictionRuleId: 'scope-1', level: original.level,
      roomTypeId: original.room_type_id, ratePlanId: original.rate_plan_id,
      channel: original.channel, effectiveFrom: isoOf(original.date_from),
      effectiveTo: isoOf(original.date_to), sourceVersion: after.version
    }), 'the key is the canonical identity of the PERSISTED row');
  });

  // ---- G. enqueue failure rolls back the rule -----------------------------

  test('G. an enqueue failure leaves NEITHER the rule change NOR the event', async () => {
    await clearEvents(tenantA);
    await handlers.upsertRestrictionRule({ ctx: ctxOf(tenantA), body: ruleBody('rb-1', { minLos: 2 }) }, res());
    const before = await rule(tenantA, 'rb-1');
    await clearEvents(tenantA);

    // Data-level failure: an invalid sourceVersion is rejected by the outbox
    // validator INSIDE the unit, after the mutation already ran. No DDL.
    await assert.rejects(() => withTenantAriUnit(pool, tenantA.tenantId, async ({ ariStore, outbox }) => {
      const saved = await ariStore.putRestrictionRule({
        tenant_id: tenantA.tenantId, id: 'rb-1', propertyId: tenantA.propertyId,
        level: 'property', date_from: D1, date_to: D2, minLos: 9
      });
      await outbox.enqueue({
        tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
        eventType: 'AVAILABILITY_CHANGED', resourceKind: 'AVAILABILITY',
        restrictionRuleId: saved.id, level: saved.level,
        roomTypeId: saved.roomTypeId, ratePlanId: saved.ratePlanId, channel: saved.channel,
        effectiveFrom: saved.date_from, effectiveTo: saved.date_to,
        sourceVersion: 0, payload: {}
      });
    }));

    const after = await rule(tenantA, 'rb-1');
    assert.equal(after.version, before.version, 'the version bump rolled back');
    assert.equal(after.min_los, before.min_los, 'the value change rolled back');
    assert.equal((await events(tenantA, "AND restriction_rule_id='rb-1'")).length, 0);
  });

  // ---- H. cross-tenant property fails closed ------------------------------

  test('H. an event naming another tenant\'s property is rejected and rolls the mutation back', async () => {
    await clearEvents(tenantA);
    await assert.rejects(() => withTenantAriUnit(pool, tenantA.tenantId, async ({ ariStore, outbox }) => {
      const saved = await ariStore.putRestrictionRule({
        tenant_id: tenantA.tenantId, id: 'xt-1', propertyId: tenantA.propertyId,
        level: 'property', date_from: D1, date_to: D2, minLos: 3
      });
      await outbox.enqueue({
        tenantId: tenantA.tenantId,
        propertyId: tenantB.propertyId, // belongs to tenant B
        eventType: 'AVAILABILITY_CHANGED', resourceKind: 'AVAILABILITY',
        restrictionRuleId: saved.id, level: saved.level,
        roomTypeId: null, ratePlanId: null, channel: null,
        effectiveFrom: saved.date_from, effectiveTo: saved.date_to,
        sourceVersion: saved.version, payload: {}
      });
    }));
    assert.equal(await rule(tenantA, 'xt-1'), null, 'the rule itself rolled back');
    assert.equal((await events(tenantA)).length, 0);
    assert.equal((await events(tenantB)).length, 0);
  });

  // ---- I. v1 and v2 coexist ----------------------------------------------

  test('I. a v1 inventory event and a v2 restriction event coexist under the same unique constraint', async () => {
    await clearEvents(tenantA);
    await H.withTenant(pool, tenantA.tenantId, (c) => c.query(
      `INSERT INTO ari_inventory_grid (tenant_id, property_id, room_type_id, date, physical, sold, blocked)
       VALUES ($1,$2,'rt-mix','2026-10-05',10,5,0)
       ON CONFLICT (tenant_id, property_id, room_type_id, date) DO NOTHING`,
      [tenantA.tenantId, tenantA.propertyId]));

    const invRes = res();
    await handlers.adjustSold({ ctx: ctxOf(tenantA), body: { roomTypeId: 'rt-mix', date: '2026-10-05', delta: 1 } }, invRes);
    assert.equal(invRes._json.data.adjusted, true);
    await handlers.upsertRestrictionRule({ ctx: ctxOf(tenantA), body: ruleBody('mix-1') }, res());

    const rows = await events(tenantA);
    const v1 = rows.filter((r) => r.dedupe_key.startsWith('aob:v1:'));
    const v2 = rows.filter((r) => r.dedupe_key.startsWith('aob:v2:'));
    assert.equal(v1.length, 1, 'the inventory event kept the v1 identity');
    assert.equal(v2.length, 1, 'the restriction event used the v2 identity');
    assert.equal(v1[0].restriction_rule_id, null);
    assert.ok(v2[0].restriction_rule_id);
  });

  // ---- J. the database rejects wrong key-version / scope combinations -----

  test('J. migration 0088 constraints reject a v1 restriction row, a v2 non-restriction row and a null room type without a rule id', async () => {
    const base = [tenantA.tenantId, tenantA.propertyId];
    const bad = [
      // a restriction row carrying a v1 key
      ["INSERT INTO ari_outbox_store (tenant_id, property_id, event_type, resource_kind, room_type_id, effective_from, effective_to, source_version, dedupe_key, restriction_rule_id) VALUES ($1,$2,'AVAILABILITY_CHANGED','AVAILABILITY',NULL,$3,$4,1,'aob:v1:" + 'f'.repeat(64) + "','r1')", 'v1 restriction'],
      // a non-restriction row carrying a v2 key
      ["INSERT INTO ari_outbox_store (tenant_id, property_id, event_type, resource_kind, room_type_id, effective_from, effective_to, source_version, dedupe_key) VALUES ($1,$2,'INVENTORY_CHANGED','INVENTORY','rt1',$3,$4,1,'aob:v2:" + 'f'.repeat(64) + "')", 'v2 non-restriction'],
      // a null room type with no restriction id
      ["INSERT INTO ari_outbox_store (tenant_id, property_id, event_type, resource_kind, room_type_id, effective_from, effective_to, source_version, dedupe_key) VALUES ($1,$2,'INVENTORY_CHANGED','INVENTORY',NULL,$3,$4,1,'aob:v1:" + 'e'.repeat(64) + "')", 'null room type without a rule id'],
      // a restriction row that is not AVAILABILITY_CHANGED
      ["INSERT INTO ari_outbox_store (tenant_id, property_id, event_type, resource_kind, room_type_id, effective_from, effective_to, source_version, dedupe_key, restriction_rule_id) VALUES ($1,$2,'INVENTORY_CHANGED','INVENTORY','rt1',$3,$4,1,'aob:v2:" + 'd'.repeat(64) + "','r1')", 'restriction on a non-availability event']
    ];
    for (const [sql, label] of bad) {
      await assert.rejects(
        () => H.withTenant(pool, tenantA.tenantId, (c) => c.query(sql, base.concat([D1, D2]))),
        'the database must reject: ' + label
      );
    }
  });

  // ---- K. isolation and legacy absence ------------------------------------

  test('K1. RLS and FORCE RLS remain enabled on ari_outbox_store', async () => {
    const r = await pool.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='ari_outbox_store'");
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].relrowsecurity, true);
    assert.equal(r.rows[0].relforcerowsecurity, true);
  });

  test('K2. tenant A cannot see tenant B restriction events', async () => {
    await clearEvents(tenantB);
    await handlers.upsertRestrictionRule({ ctx: ctxOf(tenantB), body: ruleBody('iso-1') }, res());
    assert.equal((await events(tenantB, "AND restriction_rule_id='iso-1'")).length, 1);
    const seenByA = await H.withTenant(pool, tenantA.tenantId, async (c) => {
      const q = await c.query('SELECT count(*)::int AS n FROM ari_outbox_store WHERE property_id=$1', [tenantB.propertyId]);
      return q.rows[0].n;
    });
    assert.equal(seenByA, 0);
  });

  test('K3. no channel_sync_queue_store row was created by any B2N-C2 operation', async () => {
    for (const t of [tenantA, tenantB]) {
      const n = await H.withTenant(pool, t.tenantId, async (c) => {
        const q = await c.query('SELECT count(*)::int AS n FROM channel_sync_queue_store WHERE tenant_id=$1', [t.tenantId]);
        return q.rows[0].n;
      });
      assert.equal(n, 0);
    }
  });

  test('K4. ari_outbox_store still has no reservation_id column', async () => {
    const r = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ari_outbox_store' AND column_name='reservation_id'");
    assert.equal(r.rows.length, 0);
  });
}
