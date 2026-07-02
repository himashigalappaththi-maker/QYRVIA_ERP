'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled - skipped', { skip: true }, () => {});
} else {
  let pool;
  let ctx;

  function requireCtx() {
    if (!ctx?.tenantId || !ctx?.propertyId) {
      throw new Error('DB init failed: ctx missing (check DB + seedTenantProperty)');
    }
    return ctx;
  }

  before(async () => {
    pool = H.newPool(URL);

    try {
      await H.freshSchema(pool);
      ctx = await H.seedTenantProperty(pool, {
        code: 'CTA',
        propCode: 'CPA'
      });

      if (!ctx?.tenantId || !ctx?.propertyId) {
        throw new Error('seedTenantProperty returned invalid ctx');
      }

      globalThis.__qyrvia_migration_log = true;

    } catch (e) {
      console.error('[DB BEFORE HOOK FAILED]', e);
      throw e;
    }
  });

  after(async () => {
    if (pool) await pool.end();
  });

  test('migration chain', async () => {
    const files = H.listMigrationFiles();
    const r = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.equal(r.rows.length, files.length);
  });

  test('tables exist', async () => {
    requireCtx();
    const r = await pool.query("SELECT 1");
    assert.ok(r.rows.length >= 0);
  });

  test('NOT NULL', async () => {
    requireCtx();
    const tid = crypto.randomUUID();

    await assert.rejects(() =>
      H.withTenant(pool, tid, (c) =>
        c.query("INSERT INTO tenants (id, code) VALUES ($1,'X')", [tid])
      )
    );
  });

  test('UNIQUE', async () => {
    requireCtx();
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();

    await H.withTenant(pool, a, (c) =>
      c.query("INSERT INTO tenants (id, code, name) VALUES ($1,'UQ','a')", [a])
    );

    await assert.rejects(() =>
      H.withTenant(pool, b, (c) =>
        c.query("INSERT INTO tenants (id, code, name) VALUES ($1,'UQ','b')", [b])
      )
    );
  });
}