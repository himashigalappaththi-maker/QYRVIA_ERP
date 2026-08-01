'use strict';

/**
 * Phase 66A-B2N-B — static contract test for migration 0087_ari_outbox.sql
 * (purpose-built durable ARI outbox).
 *
 * Reads the migration file as TEXT and never executes it — no database
 * connection, no migration run. Live application against real qyrvia_test is
 * covered by test/db/phase66a_b2nb_ari_outbox.db.test.js, which runs only
 * after the migration has been separately approved and applied.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIG_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');
const MIG_PATH = path.join(MIG_DIR, '0087_ari_outbox.sql');

test('migration basename is exactly 0087_ari_outbox.sql and no other 0087 exists', () => {
  assert.ok(fs.existsSync(MIG_PATH));
  const zero87 = fs.readdirSync(MIG_DIR).filter((f) => /^0087_/.test(f));
  assert.deepEqual(zero87, ['0087_ari_outbox.sql'],
    'exactly one 0087_* migration exists and it is 0087_ari_outbox.sql');
  // Deliberately NOT asserting that nothing newer exists: Phase 66A-B2N-C2
  // legitimately adds 0088_ari_outbox_restriction_scope.sql, and later
  // phases will add more. This test guards 0087's own identity and content,
  // not the end of the migration sequence.
});

const SOURCE = fs.readFileSync(MIG_PATH, 'utf8');

function stripComments(sql) {
  return sql.split('\n').map((l) => l.replace(/--.*/, '')).join('\n');
}
const CODE = stripComments(SOURCE);

test('the migration contains no BEGIN;, COMMIT; or ROLLBACK; — the runner owns the transaction', () => {
  // DO $$ ... BEGIN ... END $$ blocks are PL/pgSQL structure, not transaction
  // control; only statement-level `BEGIN;`/`COMMIT;`/`ROLLBACK;` are banned.
  assert.ok(!/\bBEGIN\s*;/m.test(CODE.replace(/BEGIN\b(?!\s*;)/g, 'PLPGSQL_BEGIN')));
  assert.ok(!/^\s*COMMIT\s*;/mi.test(CODE));
  assert.ok(!/^\s*ROLLBACK\s*;/mi.test(CODE));
});

test('creates the dedicated ari_outbox_store table', () => {
  assert.match(CODE, /CREATE TABLE ari_outbox_store\s*\(/);
});

test('every required field exists with the required nullability', () => {
  const block = CODE.match(/CREATE TABLE ari_outbox_store\s*\(([\s\S]*?)\n\);/);
  assert.ok(block, 'CREATE TABLE block found');
  const t = block[1];
  assert.match(t, /id\s+UUID\s+PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
  assert.match(t, /tenant_id\s+UUID\s+NOT NULL REFERENCES tenants\(id\)/);
  assert.match(t, /property_id\s+UUID\s+NOT NULL,/);
  assert.match(t, /event_type\s+VARCHAR\(40\)\s+NOT NULL/);
  assert.match(t, /resource_kind\s+VARCHAR\(20\)\s+NOT NULL/);
  assert.match(t, /room_type_id\s+VARCHAR\(64\)\s+NOT NULL/);
  assert.match(t, /rate_plan_id\s+VARCHAR\(64\),/);
  assert.match(t, /effective_from\s+DATE\s+NOT NULL/);
  assert.match(t, /effective_to\s+DATE\s+NOT NULL/);
  assert.match(t, /source_version\s+INTEGER\s+NOT NULL/);
  assert.match(t, /dedupe_key\s+VARCHAR\(400\)\s+NOT NULL/);
  assert.match(t, /payload_json\s+JSONB\s+NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(t, /status\s+VARCHAR\(20\)\s+NOT NULL DEFAULT 'PENDING'/);
  assert.match(t, /attempts\s+INTEGER\s+NOT NULL DEFAULT 0/);
  assert.match(t, /retry_count\s+INTEGER\s+NOT NULL DEFAULT 0/);
  assert.match(t, /max_retries\s+INTEGER\s+NOT NULL DEFAULT 4/);
  assert.match(t, /next_retry_at\s+TIMESTAMPTZ,/);
  assert.match(t, /lease_until\s+TIMESTAMPTZ,/);
  assert.match(t, /lease_owner\s+VARCHAR\(120\),/);
  assert.match(t, /created_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT now\(\)/);
  assert.match(t, /updated_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT now\(\)/);
  assert.match(t, /completed_at\s+TIMESTAMPTZ,/);
  assert.match(t, /dead_lettered_at\s+TIMESTAMPTZ,/);
});

test('event_type CHECK is exactly the three ARI event categories', () => {
  const m = CODE.match(/ari_outbox_store_event_type_check\s*\n?\s*CHECK \(event_type IN \(([^)]+)\)\)/);
  assert.ok(m);
  const values = m[1].split(',').map((v) => v.trim().replace(/'/g, ''));
  assert.deepEqual(values.sort(), ['AVAILABILITY_CHANGED', 'INVENTORY_CHANGED', 'RATE_CHANGED']);
});

test('resource_kind CHECK is exactly AVAILABILITY/RATE/INVENTORY', () => {
  const m = CODE.match(/ari_outbox_store_resource_kind_check\s*\n?\s*CHECK \(resource_kind IN \(([^)]+)\)\)/);
  assert.ok(m);
  const values = m[1].split(',').map((v) => v.trim().replace(/'/g, ''));
  assert.deepEqual(values.sort(), ['AVAILABILITY', 'INVENTORY', 'RATE']);
});

test('status CHECK is exactly PENDING/PROCESSING/COMPLETED/DEAD_LETTER — no FAILED, no RETRY_WAIT', () => {
  const m = CODE.match(/ari_outbox_store_status_check\s*\n?\s*CHECK \(status IN \(([^)]+)\)\)/);
  assert.ok(m);
  const values = m[1].split(',').map((v) => v.trim().replace(/'/g, ''));
  assert.deepEqual(values.sort(), ['COMPLETED', 'DEAD_LETTER', 'PENDING', 'PROCESSING']);
  assert.ok(!/'RETRY_WAIT'/.test(CODE), 'retry-wait stays PENDING with next_retry_at, per the B2M model');
  assert.ok(!/'FAILED'/.test(CODE), 'a brand-new table carries no historical FAILED value');
});

test('all required CHECK constraints exist', () => {
  assert.match(CODE, /ari_outbox_store_attempts_nonneg\s*\n?\s*CHECK \(attempts >= 0\)/);
  assert.match(CODE, /ari_outbox_store_retry_count_nonneg\s*\n?\s*CHECK \(retry_count >= 0\)/);
  assert.match(CODE, /ari_outbox_store_max_retries_nonneg\s*\n?\s*CHECK \(max_retries >= 0\)/);
  assert.match(CODE, /ari_outbox_store_source_version_positive\s*\n?\s*CHECK \(source_version >= 1\)/);
  assert.match(CODE, /ari_outbox_store_dedupe_key_nonempty\s*\n?\s*CHECK \(length\(dedupe_key\) > 0\)/);
  assert.match(CODE, /ari_outbox_store_room_type_nonempty\s*\n?\s*CHECK \(length\(room_type_id\) > 0\)/);
  assert.match(CODE, /ari_outbox_store_effective_range_valid\s*\n\s*CHECK \(effective_to > effective_from\)/);
});

test('event/resource compatibility CHECK pairs each event type with its exact resource kind', () => {
  const m = CODE.match(/ari_outbox_store_event_resource_compat\s*\n\s*CHECK \(([\s\S]*?)\),/);
  assert.ok(m);
  assert.match(m[1], /event_type = 'AVAILABILITY_CHANGED' AND resource_kind = 'AVAILABILITY'/);
  assert.match(m[1], /event_type = 'RATE_CHANGED'\s+AND resource_kind = 'RATE'/);
  assert.match(m[1], /event_type = 'INVENTORY_CHANGED'\s+AND resource_kind = 'INVENTORY'/);
});

test('rate_plan_id compatibility CHECK restricts it to RATE_CHANGED events', () => {
  assert.match(CODE, /ari_outbox_store_rate_plan_compat\s*\n\s*CHECK \(rate_plan_id IS NULL OR event_type = 'RATE_CHANGED'\)/);
});

// ---- B2N-B pre-application corrections ------------------------------------

test('correction 1: same-tenant property ownership is enforced by a composite foreign key', () => {
  assert.match(CODE, /CONSTRAINT ari_outbox_store_property_same_tenant_fk\s*\n\s*FOREIGN KEY \(tenant_id, property_id\)\s*\n\s*REFERENCES properties \(tenant_id, id\)/);
});

test('correction 1: a property_id-only foreign key is NOT the property relationship', () => {
  assert.ok(!/property_id\s+UUID\s+NOT NULL REFERENCES properties/.test(CODE),
    'the column must not carry a single-column FK');
  assert.ok(!/FOREIGN KEY \(property_id\)/.test(CODE),
    'no table-level single-column property FK may exist');
});

test('correction 1: the composite reference target UNIQUE (tenant_id, id) is added to properties (proven required and safe in the header)', () => {
  assert.match(CODE, /ALTER TABLE properties\s*\n\s*ADD CONSTRAINT uq_properties_tenant_property UNIQUE \(tenant_id, id\)/);
  assert.match(SOURCE, /PRIMARY KEY \(id\)|id alone is already the primary key/,
    'the safety argument (id already unique) must be documented');
  assert.match(SOURCE, /no unique contract covers \(tenant_id, id\)/,
    'the necessity argument (no existing reference target) must be documented');
});

test('correction 1: the RLS policy carries BOTH an explicit USING and an explicit WITH CHECK', () => {
  assert.match(CODE, /CREATE POLICY ari_outbox_store_by_app ON ari_outbox_store\s*\n\s*USING\s+\(tenant_id::text = current_setting\('app\.tenant_id', true\)\)\s*\n\s*WITH CHECK \(tenant_id::text = current_setting\('app\.tenant_id', true\)\)/);
});

test('correction 2: the lease-expiry recovery index exists with the documented column order (tenant_id, status, lease_until)', () => {
  assert.match(CODE, /CREATE INDEX idx_aob_lease_expiry\s*\n\s*ON ari_outbox_store \(tenant_id, status, lease_until\)/);
});

test('corrections: postconditions verify the composite FK, the properties unique target, WITH CHECK, and the global uniqueness', () => {
  assert.match(SOURCE, /con\.conname = 'uq_properties_tenant_property'/);
  assert.match(SOURCE, /con\.conname = 'ari_outbox_store_property_same_tenant_fk'/);
  assert.match(SOURCE, /with_check IS NOT NULL/);
  assert.match(SOURCE, /indexname = 'idx_aob_lease_expiry'/);
  assert.match(SOURCE, /con\.conname = 'uq_aob_logical_event'/);
});

test('no existing migration (0001-0086) is modified: content sentinels of neighbors remain intact', () => {
  const mig0086 = fs.readFileSync(path.join(MIG_DIR, '0086_channel_queue_retry_dead_letter.sql'), 'utf8');
  assert.match(mig0086, /uq_csqs_active_channel/);
  assert.match(mig0086, /'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD_LETTER'/);
  const mig0049 = fs.readFileSync(path.join(MIG_DIR, '0049_ari_foundation.sql'), 'utf8');
  assert.match(mig0049, /'ari_room_type','ari_rate_plan','ari_inventory_grid','ari_rate_rule',/);
  const mig0001 = fs.readFileSync(path.join(MIG_DIR, '0001_init.sql'), 'utf8');
  assert.match(mig0001, /UNIQUE \(tenant_id, code\)/);
  // The only ALTER of an existing table in 0087 is the additive properties
  // constraint — nothing else is altered.
  const alters = [...CODE.matchAll(/ALTER TABLE\s+(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(alters)].sort(), ['ari_outbox_store', 'properties']);
});

test('global logical-event idempotency: uq_aob_logical_event is a FULL unique constraint on (tenant_id, property_id, dedupe_key) with NO status predicate', () => {
  assert.match(CODE, /CONSTRAINT uq_aob_logical_event\s*\n\s*UNIQUE \(tenant_id, property_id, dedupe_key\)/);
  const constraintZone = CODE.slice(CODE.indexOf('uq_aob_logical_event'));
  const untilEnd = constraintZone.slice(0, constraintZone.indexOf(')') + 1);
  assert.ok(!/WHERE/.test(untilEnd), 'the uniqueness must not be status-limited');
});

test('no partial (active-only) unique index remains as the idempotency protection', () => {
  assert.ok(!/uq_aob_active_dedupe/.test(CODE), 'the old partial index must be gone');
  assert.ok(!/CREATE UNIQUE INDEX[\s\S]*?ari_outbox_store[\s\S]*?WHERE/.test(CODE),
    'no partial unique index may exist on ari_outbox_store');
  // The migration's own postcondition also enforces this at apply time.
  assert.match(SOURCE, /partial \(status-limited\) unique index/);
});

test('DEAD_LETTER replay policy is documented: explicit reviewed transition, never an implicit duplicate INSERT, not implemented in this phase', () => {
  assert.match(SOURCE, /manual replay of a[\s\S]{0,40}DEAD_LETTER event must be an explicit/);
  assert.match(SOURCE, /NOT implemented in this phase/);
});

test('claim-supporting indexes exist and lead with tenant_id', () => {
  assert.match(CODE, /CREATE INDEX idx_aob_claim\s*\n\s*ON ari_outbox_store \(tenant_id, status, created_at\)/);
  assert.match(CODE, /CREATE INDEX idx_aob_retry_due\s*\n\s*ON ari_outbox_store \(tenant_id, status, next_retry_at\)/);
});

test('RLS is enabled, forced, and the tenant policy follows the established app.tenant_id pattern', () => {
  assert.match(CODE, /ALTER TABLE ari_outbox_store ENABLE ROW LEVEL SECURITY/);
  assert.match(CODE, /ALTER TABLE ari_outbox_store FORCE\s+ROW LEVEL SECURITY/);
  assert.match(CODE, /CREATE POLICY ari_outbox_store_by_app ON ari_outbox_store\s*\n\s*USING\s+\(tenant_id::text = current_setting\('app\.tenant_id', true\)\)/);
});

test('reservation_id does not exist anywhere in the table definition', () => {
  const block = CODE.match(/CREATE TABLE ari_outbox_store\s*\(([\s\S]*?)\n\);/)[1];
  assert.ok(!/reservation_id/.test(block));
  // And the migration's own postcondition enforces this at apply time too.
  assert.match(SOURCE, /column_name = 'reservation_id'/);
});

test('no reservation-action constraint value appears', () => {
  for (const action of ['CREATE_BOOKING', 'UPDATE_BOOKING', 'CANCEL_BOOKING', 'CHECK_IN', 'CHECK_OUT']) {
    assert.ok(!CODE.includes("'" + action + "'"), action + ' must not appear in the ARI outbox migration');
  }
});

test('no role, ownership or grant statement exists — no weakening is possible', () => {
  assert.ok(!/\bCREATE ROLE\b/i.test(CODE));
  assert.ok(!/\bALTER ROLE\b/i.test(CODE));
  assert.ok(!/\bDROP ROLE\b/i.test(CODE));
  assert.ok(!/\bGRANT\b/i.test(CODE.replace(/role_table_grants/g, '')));
  assert.ok(!/\bREVOKE\b/i.test(CODE));
  assert.ok(!/\bALTER TABLE [a-z_]+ OWNER TO\b/i.test(CODE));
  assert.ok(!/BYPASSRLS/i.test(CODE.replace(/rolbypassrls/g, '')));
});

test('no bootstrap, worker_resolvers or channel_sync_queue_store alteration', () => {
  assert.ok(!/CREATE (OR REPLACE )?FUNCTION/i.test(CODE));
  assert.ok(!/ALTER TABLE channel_sync_queue_store/i.test(CODE));
  assert.ok(!/DROP.*channel_sync_queue_store/i.test(CODE));
  assert.ok(!/CREATE.*ON channel_sync_queue_store/i.test(CODE));
  assert.ok(!/ALTER FUNCTION/i.test(CODE));
  assert.ok(!/SECURITY DEFINER/i.test(CODE));
  // The queue table may appear only in read-only postconditions: no DDL
  // statement of any kind may name it (the ALTER/DROP/CREATE bans above),
  // and no INSERT/UPDATE/DELETE may touch it either.
  assert.ok(!/(INSERT INTO|UPDATE|DELETE FROM)\s+channel_sync_queue_store/i.test(CODE));
});

test('no provider URL, credential, secret or network reference exists', () => {
  assert.ok(!/https?:\/\//i.test(CODE));
  assert.ok(!/password|secret|token|credential|api[_-]?key/i.test(CODE));
});

test('postconditions verify RLS, FORCE RLS, the policy, the global uniqueness constraint, and that no resolver grant appeared', () => {
  assert.match(SOURCE, /relrowsecurity/);
  assert.match(SOURCE, /relforcerowsecurity/);
  assert.match(SOURCE, /policyname = 'ari_outbox_store_by_app'/);
  assert.match(SOURCE, /con\.conname = 'uq_aob_logical_event'/);
  assert.match(SOURCE, /grantee = 'qyrvia_auth_resolver'/);
});
