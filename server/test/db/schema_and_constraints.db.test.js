'use strict';

/**
 * Phase 9.1 - Migration chain + database-enforced constraints (DB mode).
 *
 * Proves that the SQL in 0001..NNNN actually applies to a real PostgreSQL and
 * that FK / CHECK / ENUM / NOT NULL / UNIQUE constraints are enforced by the
 * engine - not merely by application code. Skips cleanly when DB mode is off.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  let pool, ctx;

  before(async () => {
    pool = H.newPool(URL);
    const res = await H.freshSchema(pool);
    // expose for the verification report / sanity
    globalThis.__qyrvia_migration_log = res;
    ctx = await H.seedTenantProperty(pool, { code: 'CTA', propCode: 'CPA' });
  });
  after(async () => { if (pool) await pool.end(); });

  // --- migration chain ------------------------------------------------------
  test('full migration chain 0001..NNNN applied in order', async () => {
    const files = H.listMigrationFiles();
    const r = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.equal(r.rows.length, files.length, 'every migration recorded');
    assert.equal(r.rows[0].version, files[0].replace(/\.sql$/, ''));
    assert.equal(r.rows[r.rows.length - 1].version, files[files.length - 1].replace(/\.sql$/, ''));
  });

  test('core finance tables + enum types exist', async () => {
    const tables = ['tenants', 'properties', 'audit_events', 'event_store',
      'cost_centers', 'revenue_posting_map', 'ledger_batches', 'ledger_entries',
      'invoices', 'folios', 'folio_lines', 'vouchers', 'payment_allocations'];
    for (const t of tables) {
      const r = await pool.query('SELECT to_regclass($1) AS oid', ['public.' + t]);
      assert.ok(r.rows[0].oid, 'missing table: ' + t);
    }
    const e = await pool.query("SELECT 1 FROM pg_type WHERE typname = 'cost_center_type'");
    assert.equal(e.rows.length, 1, 'cost_center_type enum missing');
  });

  // --- NOT NULL -------------------------------------------------------------
  test('NOT NULL enforced (tenants.name)', async () => {
    await assert.rejects(
      () => pool.query("INSERT INTO tenants (code) VALUES ('NN1')"),
      (e) => H.isPgError(e, '23502'));   // not_null_violation
  });

  // --- UNIQUE ---------------------------------------------------------------
  test('UNIQUE enforced (tenants.code)', async () => {
    await pool.query("INSERT INTO tenants (code, name) VALUES ('UQ1','u')");
    await assert.rejects(
      () => pool.query("INSERT INTO tenants (code, name) VALUES ('UQ1','dup')"),
      (e) => H.isPgError(e, '23505'));   // unique_violation
  });

  test('UNIQUE enforced (cost_centers tenant+property+code)', async () => {
    const mk = () => pool.query(
      `INSERT INTO cost_centers (tenant_id, property_id, code, name, type)
       VALUES ($1,$2,'CC-DUP','Dup','ROOM')`, [ctx.tenantId, ctx.propertyId]);
    await mk();
    await assert.rejects(mk, (e) => H.isPgError(e, '23505'));
  });

  // --- ENUM -----------------------------------------------------------------
  test('ENUM enforced (cost_center_type rejects unknown value)', async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO cost_centers (tenant_id, property_id, code, name, type)
         VALUES ($1,$2,'CC-EN','En','BANANA')`, [ctx.tenantId, ctx.propertyId]),
      (e) => H.isPgError(e, '22'));      // 22P02 invalid_text_representation
  });

  // --- FK -------------------------------------------------------------------
  test('FK enforced - orphan ledger_entry (nonexistent batch) rejected', async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO ledger_entries (tenant_id, property_id, batch_id, entry_type,
            reference_type, reference_id, account_code, debit_amount, credit_amount)
         VALUES ($1,$2, gen_random_uuid(), 'ADJUSTMENT', 'manual', gen_random_uuid(),
                 'CASH', 10, 0)`,
        [ctx.tenantId, ctx.propertyId]),
      (e) => H.isPgError(e, '23503'));   // foreign_key_violation
  });

  test('FK enforced - cost_center referencing nonexistent property rejected', async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO cost_centers (tenant_id, property_id, code, name, type)
         VALUES ($1, gen_random_uuid(), 'CC-FK','Fk','ROOM')`, [ctx.tenantId]),
      (e) => H.isPgError(e, '23503'));
  });

  // --- CHECK: ledger batch must balance ------------------------------------
  test('CHECK enforced - ledger_batches rejects unbalanced totals', async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO ledger_batches (tenant_id, property_id, entry_type, reference_type,
            reference_id, total_debit, total_credit)
         VALUES ($1,$2,'ADJUSTMENT','manual', gen_random_uuid(), 10, 5)`,
        [ctx.tenantId, ctx.propertyId]),
      (e) => H.isPgError(e, '23514'));   // check_violation
  });

  // --- CHECK: ledger entry must be one-sided -------------------------------
  test('CHECK enforced - ledger_entries rejects two-sided leg', async () => {
    const b = await pool.query(
      `INSERT INTO ledger_batches (tenant_id, property_id, entry_type, reference_type,
          reference_id, total_debit, total_credit)
       VALUES ($1,$2,'ADJUSTMENT','manual', gen_random_uuid(), 0, 0) RETURNING id`,
      [ctx.tenantId, ctx.propertyId]);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO ledger_entries (tenant_id, property_id, batch_id, entry_type,
            reference_type, reference_id, account_code, debit_amount, credit_amount)
         VALUES ($1,$2,$3,'ADJUSTMENT','manual', gen_random_uuid(), 'CASH', 5, 5)`,
        [ctx.tenantId, ctx.propertyId, b.rows[0].id]),
      (e) => H.isPgError(e, '23514'));
  });

  test('CHECK enforced - ledger_entries rejects negative amount', async () => {
    const b = await pool.query(
      `INSERT INTO ledger_batches (tenant_id, property_id, entry_type, reference_type,
          reference_id, total_debit, total_credit)
       VALUES ($1,$2,'ADJUSTMENT','manual', gen_random_uuid(), 0, 0) RETURNING id`,
      [ctx.tenantId, ctx.propertyId]);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO ledger_entries (tenant_id, property_id, batch_id, entry_type,
            reference_type, reference_id, account_code, debit_amount, credit_amount)
         VALUES ($1,$2,$3,'ADJUSTMENT','manual', gen_random_uuid(), 'CASH', -5, 0)`,
        [ctx.tenantId, ctx.propertyId, b.rows[0].id]),
      (e) => H.isPgError(e, '23514'));
  });
}
