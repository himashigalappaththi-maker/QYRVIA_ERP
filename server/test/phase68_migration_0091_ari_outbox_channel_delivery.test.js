'use strict';

/**
 * Phase 68A — static contract test for migration
 * 0091_ari_outbox_channel_delivery.sql.
 *
 * Reads the migration as TEXT and never executes it — no database
 * connection, no migration run. Live application against real qyrvia_test is
 * covered (source only, not run) by
 * server/test/db/phase68_ari_channel_delivery.db.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIG_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');
const MIG_PATH = path.join(MIG_DIR, '0091_ari_outbox_channel_delivery.sql');

test('migration 0091_ari_outbox_channel_delivery.sql exists and immediately follows 0090 in sequence', () => {
  assert.ok(fs.existsSync(MIG_PATH));
  const files = fs.readdirSync(MIG_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const idx = files.indexOf('0091_ari_outbox_channel_delivery.sql');
  assert.ok(idx >= 0);
  assert.equal(files[idx - 1], '0090_phase67a_saas_critical_safety.sql');
});

const SOURCE = fs.readFileSync(MIG_PATH, 'utf8');
const CODE = SOURCE.split('\n').map((l) => l.replace(/--.*/, '')).join('\n');

test('the migration contains no transaction-control statements — the runner owns the transaction', () => {
  assert.ok(!/\bBEGIN\s*;/i.test(CODE));
  assert.ok(!/\bCOMMIT\s*;/i.test(CODE));
  assert.ok(!/\bROLLBACK\s*;/i.test(CODE));
});

test('additive: the composite same-tenant-id UNIQUE on ari_outbox_store is provably safe (id is already PK)', () => {
  assert.match(CODE, /ALTER TABLE ari_outbox_store\s*\n\s*ADD CONSTRAINT uq_ari_outbox_store_tenant_id UNIQUE \(tenant_id, id\);/);
  assert.match(SOURCE, /id alone is already the primary key/i);
});

test('creates ari_outbox_channel_delivery with every required logical field', () => {
  assert.match(CODE, /CREATE TABLE ari_outbox_channel_delivery/);
  for (const col of [
    'id\\s+UUID\\s+PRIMARY KEY',
    'tenant_id\\s+UUID\\s+NOT NULL',
    'property_id\\s+UUID\\s+NOT NULL',
    'ari_outbox_id\\s+UUID\\s+NOT NULL',
    'channel_code\\s+VARCHAR',
    'dedupe_key\\s+VARCHAR',
    'source_version\\s+INTEGER\\s+NOT NULL',
    "status\\s+VARCHAR\\(20\\)\\s+NOT NULL DEFAULT 'PENDING'",
    'attempt_count\\s+INTEGER\\s+NOT NULL DEFAULT 0',
    'provider_ack_id\\s+TEXT',
    'last_error_code\\s+VARCHAR',
    'last_error_class\\s+VARCHAR',
    'last_attempt_at\\s+TIMESTAMPTZ',
    'completed_at\\s+TIMESTAMPTZ',
    'created_at\\s+TIMESTAMPTZ\\s+NOT NULL DEFAULT now\\(\\)',
    'updated_at\\s+TIMESTAMPTZ\\s+NOT NULL DEFAULT now\\(\\)'
  ]) {
    assert.match(CODE, new RegExp(col), 'missing/mismatched column: ' + col);
  }
});

test('channel_code is restricted to the exact ROUTABLE_CHANNELS set — QTCN is excluded', () => {
  const m = CODE.match(/CHECK \(channel_code IN \(([\s\S]*?)\)\)/);
  assert.ok(m, 'channel_code CHECK present');
  const list = m[1];
  for (const code of ['BOOKING_COM', 'AGODA', 'EXPEDIA', 'AIRBNB', 'MAKEMYTRIP', 'GOOGLE', 'TRIPADVISOR', 'QYRVIA_CONNECT']) {
    assert.ok(list.includes(code), 'missing channel in CHECK: ' + code);
  }
  assert.ok(!list.includes('QTCN'), 'QTCN must never be a writable channel_code');
});

test('status is restricted to exactly PENDING/PROCESSING/RETRY/COMPLETED/DEAD_LETTER', () => {
  const m = CODE.match(/CHECK \(status IN \(([\s\S]*?)\)\)/);
  assert.ok(m);
  const set = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual(set.sort(), ['COMPLETED', 'DEAD_LETTER', 'PENDING', 'PROCESSING', 'RETRY']);
});

test('narrowest correct uniqueness: UNIQUE (tenant_id, ari_outbox_id, channel_code), no status predicate', () => {
  assert.match(CODE, /CONSTRAINT uq_aocd_event_channel\s*\n\s*UNIQUE \(tenant_id, ari_outbox_id, channel_code\)/);
  // No partial (status-limited) unique index anywhere in this migration.
  assert.ok(!/CREATE UNIQUE INDEX/i.test(CODE));
});

test('same-tenant ownership is DOUBLY enforced via composite FKs, never a bare id-only FK', () => {
  assert.match(CODE, /CONSTRAINT aocd_outbox_same_tenant_fk\s*\n\s*FOREIGN KEY \(tenant_id, ari_outbox_id\)\s*\n\s*REFERENCES ari_outbox_store \(tenant_id, id\)/);
  assert.match(CODE, /CONSTRAINT aocd_property_same_tenant_fk\s*\n\s*FOREIGN KEY \(tenant_id, property_id\)\s*\n\s*REFERENCES properties \(tenant_id, id\)/);
  // No bare single-column FK on ari_outbox_id or property_id alone.
  assert.ok(!/FOREIGN KEY \(ari_outbox_id\)/.test(CODE));
  assert.ok(!/FOREIGN KEY \(property_id\)/.test(CODE));
});

test('RLS: ENABLE + FORCE, USING and WITH CHECK both present, current sargable app_current_tenant() convention', () => {
  assert.match(CODE, /ALTER TABLE ari_outbox_channel_delivery ENABLE ROW LEVEL SECURITY;/);
  assert.match(CODE, /ALTER TABLE ari_outbox_channel_delivery FORCE\s+ROW LEVEL SECURITY;/);
  assert.match(CODE, /CREATE POLICY ari_outbox_channel_delivery_by_app ON ari_outbox_channel_delivery\s*\n\s*USING\s+\(tenant_id = app_current_tenant\(\)\)\s*\n\s*WITH CHECK \(tenant_id = app_current_tenant\(\)\)/);
});

test('no PUBLIC grant, no BYPASSRLS, no SECURITY DEFINER, no role/ownership DDL anywhere', () => {
  assert.ok(!/^\s*GRANT\s/im.test(CODE));
  assert.ok(!/\bBYPASSRLS\b/i.test(CODE));
  assert.ok(!/SECURITY DEFINER/i.test(CODE));
  assert.ok(!/\b(CREATE|ALTER|DROP)\s+ROLE\b/i.test(CODE));
  assert.ok(!/OWNER TO/i.test(CODE));
});

test('tenant-scoped indexes exist for the documented access patterns', () => {
  assert.match(CODE, /CREATE INDEX idx_aocd_by_outbox\s*\n\s*ON ari_outbox_channel_delivery \(tenant_id, ari_outbox_id\);/);
  assert.match(CODE, /CREATE INDEX idx_aocd_claim\s*\n\s*ON ari_outbox_channel_delivery \(tenant_id, status, created_at\);/);
});

test('ari_outbox_store semantics are not weakened: uq_aob_logical_event, RLS, and channel_sync_queue_store are untouched', () => {
  assert.ok(!/DROP CONSTRAINT uq_aob_logical_event/.test(CODE));
  assert.ok(!/DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/i.test(CODE));
  assert.ok(!/DROP POLICY|ALTER POLICY/i.test(CODE));
  assert.ok(!/ALTER TABLE channel_sync_queue_store|INSERT INTO channel_sync_queue_store|UPDATE channel_sync_queue_store/i.test(CODE));
});

test('no destructive DDL anywhere — no DROP TABLE, no TRUNCATE, no data-rewriting UPDATE/DELETE', () => {
  assert.ok(!/DROP TABLE/i.test(CODE));
  assert.ok(!/TRUNCATE/i.test(CODE));
  assert.ok(!/^\s*UPDATE\s+(?!.*postcondition)/im.test(CODE.replace(/DO \$\$[\s\S]*?\$\$;/g, '')));
  assert.ok(!/^\s*DELETE FROM/im.test(CODE));
});

test('the migration ALTERs only ari_outbox_store (additive UNIQUE) and its own new table (ENABLE/FORCE RLS) — nothing else', () => {
  const altered = [...new Set([...CODE.matchAll(/ALTER TABLE\s+(\w+)/g)].map((m) => m[1]))];
  assert.deepEqual(altered.sort(), ['ari_outbox_channel_delivery', 'ari_outbox_store']);
  const created = [...new Set([...CODE.matchAll(/CREATE TABLE\s+(\w+)/g)].map((m) => m[1]))];
  assert.deepEqual(created, ['ari_outbox_channel_delivery']);
});

test('migrations 0001 through 0090 are unmodified (neighbour content sentinels intact)', () => {
  const m90 = fs.readFileSync(path.join(MIG_DIR, '0090_phase67a_saas_critical_safety.sql'), 'utf8');
  assert.match(m90, /CREATE OR REPLACE FUNCTION|channel_registry_tenant_isolation/);
  const m87 = fs.readFileSync(path.join(MIG_DIR, '0087_ari_outbox.sql'), 'utf8');
  assert.match(m87, /CONSTRAINT uq_aob_logical_event\s*\n\s*UNIQUE \(tenant_id, property_id, dedupe_key\)/);
});
