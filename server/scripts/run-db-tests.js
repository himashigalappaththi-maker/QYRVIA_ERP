'use strict';

/**
 * Safe serial DB test runner (Phase 61).
 *
 * SAFETY CONTRACT
 * ───────────────
 * 1. Loads DATABASE_URL exclusively from server/.env via dotenv — never from a
 *    CLI argument, environment variable assignment, or literal string.
 * 2. Parses the URL and verifies:
 *      hostname  ∈ { 127.0.0.1, localhost }
 *      database  === 'qyrvia_test'
 *    Refuses to run against any other host or database.
 * 3. Prints only the sanitized host and database name — never the full URL,
 *    password, token, or any other credential.
 * 4. Sets process.env.TEST_DATABASE_URL = process.env.DATABASE_URL internally
 *    so the DB test harness (_dbHarness.js) enables DB mode.
 * 5. Executes every test/db/*.db.test.js file sequentially using
 *    --test-concurrency=1 and shell:false.
 *
 * WHY SERIAL EXECUTION IS REQUIRED
 * ──────────────────────────────────
 * Every DB test file calls freshSchema(pool), which executes:
 *
 *     DROP SCHEMA IF EXISTS public CASCADE
 *     CREATE SCHEMA public
 *
 * against the shared qyrvia_test database. Running two or more DB test files
 * concurrently causes their freshSchema() calls to race: one file drops the
 * schema while another file's tests are running against it, producing spurious
 * failures unrelated to the code under test. --test-concurrency=1 guarantees
 * that only one DB test file runs at a time, eliminating the race.
 *
 * Usage:
 *   node scripts/run-db-tests.js          (reads DATABASE_URL from server/.env)
 *   npm run test:db-safe                  (same via package.json script)
 */

require('dotenv').config();

const { spawnSync } = require('node:child_process');
const fs   = require('node:fs');
const path = require('node:path');

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error('[db-runner] DATABASE_URL not set — cannot run DB tests');
  console.error('[db-runner] Copy .env.example to .env and set DATABASE_URL');
  process.exit(1);
}

let parsed;
try { parsed = new URL(raw); }
catch (_) {
  console.error('[db-runner] DATABASE_URL is not a valid URL');
  process.exit(1);
}

const host = parsed.hostname;
const db   = parsed.pathname.replace(/^\//, '');

if (host !== '127.0.0.1' && host !== 'localhost') {
  console.error('[db-runner] SAFETY ABORT: target host is not local — refusing to run');
  console.error('[db-runner] DB tests must only run against a local qyrvia_test database');
  process.exit(1);
}
if (db !== 'qyrvia_test') {
  console.error('[db-runner] SAFETY ABORT: target database is not qyrvia_test — refusing to run');
  process.exit(1);
}

console.log('[db-runner] target: host=' + host + ' db=' + db);

const testDir = path.join(__dirname, '..', 'test', 'db');
const files = fs.readdirSync(testDir)
  .filter((f) => f.endsWith('.db.test.js'))
  .map((f) => path.join(testDir, f))
  .sort();

console.log('[db-runner] discovered ' + files.length + ' DB test file(s)');
console.log('[db-runner] executing serially (--test-concurrency=1) to prevent freshSchema() race');

process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;

const result = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', ...files],
  { stdio: 'inherit', shell: false, env: process.env }
);

process.exit(result.status ?? 1);
