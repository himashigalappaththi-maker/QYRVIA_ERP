'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const MIG_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');

function listSql() {
  return fs.readdirSync(MIG_DIR).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort();
}
function read(f) { return fs.readFileSync(path.join(MIG_DIR, f), 'utf8'); }

test('migrations directory has the expected ordered sequence', () => {
  const files = listSql();
  assert.ok(files.length >= 15, 'expected at least 0001..0015, got ' + files.length);
  for (let i = 0; i < files.length; i++) {
    const expectedPrefix = String(i + 1).padStart(4, '0') + '_';
    assert.ok(files[i].startsWith(expectedPrefix),
      'expected ' + expectedPrefix + '* at index ' + i + ', got ' + files[i]);
  }
});

test('no migration uses PRIMARY KEY (..., COALESCE(...)) - INVALID on Postgres', () => {
  for (const f of listSql()) {
    const sql = read(f);
    assert.ok(!/PRIMARY\s+KEY\s*\([^)]*COALESCE/i.test(sql),
      f + ' has PRIMARY KEY containing COALESCE expression (PG forbids it)');
  }
});

test('no migration uses UNIQUE (..., COALESCE(...)) inside a CREATE TABLE constraint', () => {
  for (const f of listSql()) {
    const sql = read(f);
    // Inside CREATE TABLE blocks UNIQUE(...COALESCE(...)) is invalid.
    // The valid expression form is CREATE UNIQUE INDEX ... ON tbl (... COALESCE(...));
    // so we permit COALESCE inside a CREATE UNIQUE INDEX line.
    const lines = sql.split('\n');
    let inTable = false;
    for (const line of lines) {
      if (/^\s*CREATE\s+TABLE\b/i.test(line)) inTable = true;
      if (inTable && /UNIQUE\s*\([^)]*COALESCE/i.test(line)) {
        assert.fail(f + ' has UNIQUE(...COALESCE(...)) inside CREATE TABLE - convert to a CREATE UNIQUE INDEX');
      }
      if (inTable && /^\s*\);\s*$/.test(line)) inTable = false;
    }
  }
});

test('every tenant-scoped table has ENABLE + FORCE ROW LEVEL SECURITY', () => {
  // Tables that we expect to be RLS-enabled across all phases.
  const expected = [
    'tenants','properties','audit_events',                                                 // Phase 1
    'users','user_roles','refresh_tokens',                                                 // Phase 2
    'event_store','scheduled_jobs','notifications','notification_templates',
    'notification_delivery_log','settings','files','connector_configs',
    'connector_health_log','webhook_endpoints','webhook_deliveries',                       // Phase 3
    'aggregate_snapshots','scheduled_job_recurrence'                                       // Phase 4
  ];
  // Concatenate every migration's SQL once.
  const all = listSql().map(read).join('\n');
  for (const table of expected) {
    const enabled = new RegExp('ALTER\\s+TABLE\\s+' + table + '\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY', 'i').test(all);
    const forced  = new RegExp('ALTER\\s+TABLE\\s+' + table + '\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY', 'i').test(all);
    assert.ok(enabled, table + ' missing ENABLE ROW LEVEL SECURITY');
    assert.ok(forced,  table + ' missing FORCE ROW LEVEL SECURITY');
  }
});

test('append-only tables have UPDATE/DELETE revoked', () => {
  const all = listSql().map(read).join('\n');
  // Phase 1+3: audit_events + event_store. Phase 6: ai_conversations + ai_messages.
  ['audit_events','event_store','ai_conversations','ai_messages'].forEach((t) => {
    const r = new RegExp('REVOKE\\s+UPDATE\\s*,\\s*DELETE\\s+ON\\s+' + t + '\\s+FROM\\s+PUBLIC', 'i');
    assert.ok(r.test(all), t + ' missing REVOKE UPDATE,DELETE FROM PUBLIC');
  });
});

test('Phase 6: property-scoped audit_events partial index exists', () => {
  const all = listSql().map(read).join('\n');
  assert.match(all, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_audit_events_property_time/i);
  assert.match(all, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_event_store_property_time/i);
});

test('migrations create gen_random_uuid extension early', () => {
  const sql = read(listSql()[0]);
  assert.ok(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+"pgcrypto"/i.test(sql),
    '0001 must enable pgcrypto for gen_random_uuid()');
});

test('every CREATE TABLE has either an id PRIMARY KEY or composite PRIMARY KEY of column names only', () => {
  for (const f of listSql()) {
    const sql = read(f);
    // crude check: each CREATE TABLE block must contain PRIMARY KEY somewhere
    // (either inline or as constraint). We exclude pure stand-alone helpers.
    const tableBlocks = sql.split(/\bCREATE\s+TABLE\b/i).slice(1);
    for (const block of tableBlocks) {
      const body = block.split(';')[0];
      // Either column-level "PRIMARY KEY" OR table-level "PRIMARY KEY (cols)"
      if (!/PRIMARY\s+KEY/i.test(body)) {
        assert.fail(f + ' has a CREATE TABLE without PRIMARY KEY: ' + body.slice(0, 80));
      }
    }
  }
});
