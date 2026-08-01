'use strict';

/**
 * Phase 66A-B2N-C2 — static contract test for migration 0088
 * (ARI outbox support for restriction-rule scope).
 *
 * Reads the migration as TEXT and never executes it — no database
 * connection, no migration run. Live application against real qyrvia_test is
 * covered by test/db/phase66a_b2nc2_restriction_outbox.db.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIG_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');
const MIG_PATH = path.join(MIG_DIR, '0088_ari_outbox_restriction_scope.sql');

test('migration 0088_ari_outbox_restriction_scope.sql exists with the exact basename', () => {
  assert.ok(fs.existsSync(MIG_PATH));
  const files = fs.readdirSync(MIG_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  assert.equal(files[files.length - 1], '0088_ari_outbox_restriction_scope.sql', 'it is the newest migration');
});

const SOURCE = fs.readFileSync(MIG_PATH, 'utf8');
const CODE = SOURCE.split('\n').map((l) => l.replace(/--.*/, '')).join('\n');

test('the migration contains no transaction-control statements — the runner owns the transaction', () => {
  assert.ok(!/\bBEGIN\s*;/i.test(CODE));
  assert.ok(!/\bCOMMIT\s*;/i.test(CODE));
  assert.ok(!/\bROLLBACK\s*;/i.test(CODE));
});

// ---- A/B: the restriction identity column --------------------------------

test('A. restriction_rule_id is added as a nullable VARCHAR(80) with no foreign key', () => {
  assert.match(CODE, /ALTER TABLE ari_outbox_store\s*\n\s*ADD COLUMN restriction_rule_id VARCHAR\(80\);/);
  assert.ok(!/restriction_rule_id[\s\S]{0,80}REFERENCES/i.test(CODE), 'no FK — outbox history outlives the rule');
  assert.ok(!/ADD COLUMN restriction_rule_id[^;]*NOT NULL/i.test(CODE), 'nullable');
  // The rationale is documented (the phrase wraps across comment lines).
  assert.match(SOURCE.replace(/\s*\n--\s*/g, ' '), /outbox history must survive/i,
    'the no-FK rationale is documented');
});

test('B. a non-empty restriction id CHECK exists', () => {
  assert.match(CODE, /ADD CONSTRAINT ari_outbox_store_restriction_rule_id_nonempty\s*\n\s*CHECK \(restriction_rule_id IS NULL OR length\(restriction_rule_id\) > 0\)/);
});

// ---- C/D: room_type_id becomes nullable, empty still illegal -------------

test('C. room_type_id NOT NULL is dropped', () => {
  assert.match(CODE, /ALTER TABLE ari_outbox_store\s*\n\s*ALTER COLUMN room_type_id DROP NOT NULL;/);
});

test('D. the room-type non-empty CHECK is replaced with a null-tolerant one', () => {
  assert.match(CODE, /DROP CONSTRAINT ari_outbox_store_room_type_nonempty;/);
  assert.match(CODE, /ADD CONSTRAINT ari_outbox_store_room_type_nonempty\s*\n\s*CHECK \(room_type_id IS NULL OR length\(room_type_id\) > 0\)/);
});

test('E. a room type is still REQUIRED for every non-restriction event', () => {
  assert.match(CODE, /ADD CONSTRAINT ari_outbox_store_room_type_required\s*\n\s*CHECK \(room_type_id IS NOT NULL OR restriction_rule_id IS NOT NULL\)/);
});

// ---- F: rate-plan compatibility widened for restrictions only ------------

test('F. rate_plan_id is widened ONLY for restriction AVAILABILITY_CHANGED/AVAILABILITY events', () => {
  assert.match(CODE, /DROP CONSTRAINT ari_outbox_store_rate_plan_compat;/);
  const m = CODE.match(/ADD CONSTRAINT ari_outbox_store_rate_plan_compat\s*\n\s*CHECK \(([\s\S]*?)\n\s*\);/);
  assert.ok(m, 'the widened rate-plan CHECK is present');
  const body = m[1];
  assert.match(body, /rate_plan_id IS NULL/);
  assert.match(body, /event_type = 'RATE_CHANGED'/);
  assert.match(body, /restriction_rule_id IS NOT NULL/);
  assert.match(body, /event_type = 'AVAILABILITY_CHANGED'/);
  assert.match(body, /resource_kind = 'AVAILABILITY'/);
  // A non-restriction AVAILABILITY_CHANGED or INVENTORY_CHANGED must still
  // reject it: the widened arm is gated on restriction_rule_id IS NOT NULL.
  assert.ok(/OR \(restriction_rule_id IS NOT NULL/.test(body.replace(/\s+/g, ' ')),
    'the widened arm is gated on a present restriction id');
});

// ---- G: restriction implies AVAILABILITY_CHANGED / AVAILABILITY ----------

test('G. restriction_rule_id implies exactly AVAILABILITY_CHANGED / AVAILABILITY', () => {
  assert.match(CODE, /ADD CONSTRAINT ari_outbox_store_restriction_event_compat\s*\n\s*CHECK \(\s*\n\s*restriction_rule_id IS NULL\s*\n\s*OR \(event_type = 'AVAILABILITY_CHANGED' AND resource_kind = 'AVAILABILITY'\)/);
});

// ---- H: exact key-version binding ----------------------------------------

test('H. the key-version CHECK binds v1 to non-restriction and v2 to restriction, rejecting anything else', () => {
  const m = CODE.match(/ADD CONSTRAINT ari_outbox_store_key_version_compat\s*\n\s*CHECK \(([\s\S]*?)\n\s*\);/);
  assert.ok(m, 'the key-version CHECK is present');
  const body = m[1].replace(/\s+/g, ' ');
  assert.match(body, /\(restriction_rule_id IS NULL AND dedupe_key LIKE 'aob:v1:%'\)/);
  assert.match(body, /\(restriction_rule_id IS NOT NULL AND dedupe_key LIKE 'aob:v2:%'\)/);
  assert.match(body, /OR/);
  // Both arms require a versioned prefix, so an unversioned key is rejected
  // whichever branch is taken.
  assert.equal((body.match(/dedupe_key LIKE/g) || []).length, 2);
});

// ---- I: everything that must be preserved --------------------------------

test('I. global logical uniqueness is untouched and no partial unique index is introduced', () => {
  assert.ok(!/DROP CONSTRAINT uq_aob_logical_event|ADD CONSTRAINT uq_aob_logical_event/.test(CODE),
    'uq_aob_logical_event is neither dropped nor redefined');
  assert.ok(!/CREATE UNIQUE INDEX/i.test(CODE), 'no new unique index at all');
  assert.match(SOURCE, /uq_aob_logical_event is deliberately left exactly as-is/);
});

test('I. RLS, FORCE RLS, the tenant policy, the composite property FK and the claim indexes are all preserved', () => {
  // Nothing may be altered…
  assert.ok(!/DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/i.test(CODE));
  assert.ok(!/DROP POLICY|CREATE POLICY|ALTER POLICY/i.test(CODE));
  assert.ok(!/ari_outbox_store_property_same_tenant_fk[\s\S]{0,40}DROP/i.test(CODE));
  assert.ok(!/DROP INDEX/i.test(CODE));
  // …and the postconditions actively assert each one survived.
  for (const marker of [
    /relrowsecurity/, /relforcerowsecurity/,
    /policyname='ari_outbox_store_by_app'[\s\S]{0,80}qual IS NOT NULL AND with_check IS NOT NULL/,
    /conname='ari_outbox_store_property_same_tenant_fk'/,
    /conname='uq_properties_tenant_property'/,
    /'idx_aob_claim','idx_aob_retry_due','idx_aob_lease_expiry'/,
    /column_name='reservation_id'/
  ]) {
    assert.match(SOURCE, marker);
  }
});

test('I/J. no existing aob:v1 key is rewritten and no row is backfilled', () => {
  assert.ok(!/UPDATE ari_outbox_store/i.test(CODE), 'no data rewrite of any kind');
  assert.ok(!/INSERT INTO ari_outbox_store/i.test(CODE), 'no backfill');
  assert.match(SOURCE, /NO backfill and NO duplicate preflight is\n-- required/);
});

test('J. no role, ownership, grant, RLS or permission change, and channel_sync_queue_store is untouched', () => {
  // Only actual DDL verbs count. The postcondition block legitimately READS
  // pg_roles.rolbypassrls and information_schema.role_table_grants to prove
  // nothing changed; those are assertions, not grants.
  assert.ok(!/\b(CREATE|ALTER|DROP)\s+ROLE\b/i.test(CODE), 'no role DDL');
  assert.ok(!/^\s*(GRANT|REVOKE)\s/im.test(CODE), 'no grant or revoke statement');
  assert.ok(!/OWNER TO/i.test(CODE), 'no ownership change');
  assert.ok(!/\bWITH\s+(BYPASSRLS|SUPERUSER)\b/i.test(CODE), 'no privileged role attribute granted');
  assert.ok(!/ALTER TABLE channel_sync_queue_store|INSERT INTO channel_sync_queue_store|UPDATE channel_sync_queue_store/i.test(CODE));
  assert.ok(!/ALTER\s+\w*\s*worker_resolvers|CREATE\s+\w*\s*worker_resolvers/i.test(CODE), 'worker_resolvers not altered');
  assert.ok(!/reservation_id\s+VARCHAR|ADD COLUMN reservation_id/i.test(CODE));
});

test('the migration alters ONLY ari_outbox_store', () => {
  const altered = [...new Set([...CODE.matchAll(/ALTER TABLE\s+(\w+)/g)].map((m) => m[1]))];
  assert.deepEqual(altered, ['ari_outbox_store']);
});

test('migrations 0001 through 0087 are unmodified (neighbour content sentinels intact)', () => {
  const m87 = fs.readFileSync(path.join(MIG_DIR, '0087_ari_outbox.sql'), 'utf8');
  assert.match(m87, /CONSTRAINT uq_aob_logical_event\s*\n\s*UNIQUE \(tenant_id, property_id, dedupe_key\)/);
  assert.match(m87, /FOREIGN KEY \(tenant_id, property_id\)/);
  assert.match(m87, /room_type_id     VARCHAR\(64\)  NOT NULL/, '0087 still declares its original NOT NULL');
  const m86 = fs.readFileSync(path.join(MIG_DIR, '0086_channel_queue_retry_dead_letter.sql'), 'utf8');
  assert.match(m86, /uq_csqs_active_channel/);
  const m49 = fs.readFileSync(path.join(MIG_DIR, '0049_ari_foundation.sql'), 'utf8');
  assert.match(m49, /CREATE TABLE ari_restriction_rule/);
});
