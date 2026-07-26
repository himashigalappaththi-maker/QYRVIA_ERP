'use strict';

/**
 * Phase 63 P0-2 — boot-time migration preflight.
 *
 * The launch blocker being closed here: a container started against a database
 * missing the latest migrations used to boot cleanly, answer /health/ready with
 * {db:"ok"} (that probe only pings the connection), get marked healthy, and
 * then serve reservation and financial traffic against a stale schema.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  listMigrationVersions,
  inspectMigrationState,
  runMigrationPreflight,
  MIGRATIONS_DIR
} = require('../src/db/migrationPreflight');

function tmpMigrationsDir(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qyrvia-migr-'));
  for (const n of names) fs.writeFileSync(path.join(dir, n), '-- test\n');
  return dir;
}

function stubDb(rowsOrError) {
  if (rowsOrError instanceof Error) {
    return { async query() { throw rowsOrError; } };
  }
  return { async query() { return { rows: rowsOrError.map((v) => ({ version: v })) }; } };
}

function capturingLogger() {
  const calls = { info: [], warn: [], error: [] };
  return {
    calls,
    info(o, m) { calls.info.push({ o, m }); },
    warn(o, m) { calls.warn.push({ o, m }); },
    error(o, m) { calls.error.push({ o, m }); }
  };
}

test('listMigrationVersions reads the real migrations dir in lexical order', () => {
  const versions = listMigrationVersions(MIGRATIONS_DIR);
  assert.ok(versions.length > 50, 'the repo ships a substantial migration chain');
  assert.equal(versions[0], '0001_init');
  const sorted = [...versions].sort();
  assert.deepEqual(versions, sorted, 'ordering must be lexical — the runner depends on it');
  assert.ok(versions.every((v) => !v.endsWith('.sql')), 'versions exclude the .sql suffix');
});

test('a fully migrated database is ok', async () => {
  const dir = tmpMigrationsDir(['0001_a.sql', '0002_b.sql']);
  const s = await inspectMigrationState(stubDb(['0001_a', '0002_b']), { dir });
  assert.equal(s.ok, true);
  assert.deepEqual(s.pending, []);
  assert.deepEqual(s.unknown, []);
  assert.equal(s.applied, 2);
  assert.equal(s.total, 2);
});

test('pending migrations are detected and named', async () => {
  const dir = tmpMigrationsDir(['0001_a.sql', '0002_b.sql', '0003_c.sql']);
  const s = await inspectMigrationState(stubDb(['0001_a']), { dir });
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'pending_migrations');
  assert.deepEqual(s.pending, ['0002_b', '0003_c']);
});

test('a schema AHEAD of the build (rolled-back artifact) is also unsafe', async () => {
  const dir = tmpMigrationsDir(['0001_a.sql', '0002_b.sql']);
  const s = await inspectMigrationState(stubDb(['0001_a', '0002_b', '0003_from_the_future']), { dir });
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'schema_ahead_of_build');
  assert.deepEqual(s.unknown, ['0003_from_the_future']);
});

test('an unreadable schema_migrations table is treated as total drift, not shrugged off', async () => {
  const dir = tmpMigrationsDir(['0001_a.sql', '0002_b.sql']);
  const s = await inspectMigrationState(stubDb(new Error('relation "schema_migrations" does not exist')), { dir });
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'schema_migrations_unreadable');
  assert.deepEqual(s.pending, ['0001_a', '0002_b']);
});

test('PRODUCTION: pending migrations are FATAL (boot must abort)', async () => {
  const dir = tmpMigrationsDir(['0001_a.sql', '0002_b.sql']);
  const log = capturingLogger();
  const { fatal, state } = await runMigrationPreflight({
    queryable: stubDb(['0001_a']), isProduction: true, logger: log, dir
  });
  assert.equal(fatal, true);
  assert.equal(state.reason, 'pending_migrations');
  assert.equal(log.calls.error.length, 1);
  assert.equal(log.calls.error[0].o.code, 'migration_preflight_failed');
});

test('NON-PRODUCTION: pending migrations warn but never block a developer', async () => {
  const dir = tmpMigrationsDir(['0001_a.sql', '0002_b.sql']);
  const log = capturingLogger();
  const { fatal } = await runMigrationPreflight({
    queryable: stubDb(['0001_a']), isProduction: false, logger: log, dir
  });
  assert.equal(fatal, false);
  assert.equal(log.calls.warn.length, 1);
  assert.equal(log.calls.error.length, 0);
});

test('PRODUCTION: an up-to-date schema boots and logs the version count', async () => {
  const dir = tmpMigrationsDir(['0001_a.sql', '0002_b.sql']);
  const log = capturingLogger();
  const { fatal } = await runMigrationPreflight({
    queryable: stubDb(['0001_a', '0002_b']), isProduction: true, logger: log, dir
  });
  assert.equal(fatal, false);
  assert.equal(log.calls.info.length, 1);
  assert.equal(log.calls.info[0].o.applied, 2);
});

test('PRODUCTION: no database handle is fatal — we must not boot unable to prove the schema', async () => {
  const log = capturingLogger();
  const prod = await runMigrationPreflight({ queryable: null, isProduction: true, logger: log });
  assert.equal(prod.fatal, true);
  assert.equal(prod.state.reason, 'no_database_handle');

  const dev = await runMigrationPreflight({ queryable: null, isProduction: false, logger: capturingLogger() });
  assert.equal(dev.fatal, false);
});

test('preflight is read-only: it issues exactly one SELECT and never writes', async () => {
  const dir = tmpMigrationsDir(['0001_a.sql']);
  const issued = [];
  const q = { async query(sql) { issued.push(sql); return { rows: [{ version: '0001_a' }] }; } };
  await runMigrationPreflight({ queryable: q, isProduction: true, logger: capturingLogger(), dir });
  assert.equal(issued.length, 1);
  assert.match(issued[0], /^SELECT version FROM schema_migrations/);
  assert.ok(!/INSERT|UPDATE|DELETE|DROP|ALTER|CREATE/i.test(issued[0]));
});
