'use strict';

/**
 * Phase 61: Production Deployment Preflight Gate.
 *
 * Read-only script. Does NOT start the server, modify any files, or write to
 * the database. Validates:
 *
 *   1. Environment variables (required keys present, no placeholders)
 *   2. Production-gate conditions via validateProductionEnv
 *   3. Critical source files present in the build tree
 *   4. Database connectivity and latest migration applied (if DATABASE_URL set)
 *   5. RLS FORCE enabled on the core multi-tenant tables
 *   6. DB role is not a superuser and does not have BYPASSRLS
 *
 * Exit codes:
 *   0  all checks pass (or only warnings)
 *   1  one or more FAIL checks
 *
 * Usage:
 *   node scripts/prod-preflight.js
 *   NODE_ENV=production node scripts/prod-preflight.js
 */

require('dotenv').config();

const fs   = require('node:fs');
const path = require('node:path');
const { validateProductionEnv, looksLikePlaceholder } = require('../src/config/envValidation');

const ROOT = path.join(__dirname, '..');

let passed  = 0;
let warned  = 0;
let failed  = 0;

function pass(label)      { passed++;  console.log('  PASS  ' + label); }
function warn(label, msg) { warned++;  console.log('  WARN  ' + label + (msg ? ' — ' + msg : '')); }
function fail(label, msg) { failed++;  console.error('  FAIL  ' + label + (msg ? ' — ' + msg : '')); }

// ---------------------------------------------------------------------------
// 1. Environment variable validation
// ---------------------------------------------------------------------------

console.log('\n[1/5] Environment variables\n');

const env = {
  NODE_ENV:                          process.env.NODE_ENV                          || 'development',
  DATABASE_URL:                      process.env.DATABASE_URL                      || '',
  JWT_SECRET:                        process.env.JWT_SECRET                        || '',
  APP_BASE_URL:                      process.env.APP_BASE_URL                      || 'http://localhost:3001',
  PAYMENT_PROVIDER:                  process.env.PAYMENT_PROVIDER                  || 'mock',
  QYRVIA_NOTIFICATION_ENCRYPTION_KEY: process.env.QYRVIA_NOTIFICATION_ENCRYPTION_KEY || '',
  SMTP_HOST:                         process.env.SMTP_HOST                         || '',
  RESEND_API_KEY:                    process.env.RESEND_API_KEY                    || '',
  CHANNEL_OTA_ACTIVATIONS:           process.env.CHANNEL_OTA_ACTIVATIONS           || '',
  CHANNEL_CREDENTIAL_KEY:            process.env.CHANNEL_CREDENTIAL_KEY            || '',
  CORS_ORIGIN:                       process.env.CORS_ORIGIN                       || '',
  TRUST_PROXY:                       process.env.TRUST_PROXY                       || '1',
};

if (!env.DATABASE_URL) {
  fail('DATABASE_URL', 'not set');
} else {
  pass('DATABASE_URL present');
}

if (!env.JWT_SECRET) {
  fail('JWT_SECRET', 'not set');
} else if (looksLikePlaceholder(env.JWT_SECRET)) {
  fail('JWT_SECRET', 'appears to be a placeholder');
} else if (env.JWT_SECRET.length < 32) {
  fail('JWT_SECRET', 'too short (min 32 chars)');
} else if (env.JWT_SECRET.length < 64) {
  warn('JWT_SECRET', 'should be ≥ 64 chars for production (current: ' + env.JWT_SECRET.length + ')');
  pass('JWT_SECRET present and non-placeholder');
} else {
  pass('JWT_SECRET present, non-placeholder, ≥ 64 chars');
}

// Run the canonical production validation from envValidation.js
const { errors: envErrors, warnings: envWarnings } = validateProductionEnv(env);
for (const w of envWarnings) warn('env', w);
for (const e of envErrors)   fail('env', e);
if (envErrors.length === 0 && envWarnings.filter((w) => !w.startsWith('CORS')).length === 0) {
  pass('validateProductionEnv — all required conditions met');
}

// ---------------------------------------------------------------------------
// 2. Critical source files
// ---------------------------------------------------------------------------

console.log('\n[2/5] Critical source files\n');

const REQUIRED_FILES = [
  'src/index.js',
  'src/app.js',
  'src/config/env.js',
  'src/config/envValidation.js',
  'src/lifecycle/shutdown.js',
  'src/db/migrate.js',
  'src/middleware/security.js',
  'src/db/client.js',
  'src/db/migrations/0001_init.sql',
];

for (const rel of REQUIRED_FILES) {
  const full = path.join(ROOT, rel);
  if (fs.existsSync(full)) {
    pass(rel);
  } else {
    fail(rel, 'file not found');
  }
}

// Latest migration directory sanity check
const migrationsDir = path.join(ROOT, 'src/db/migrations');
let migrationFiles = [];
try {
  migrationFiles = fs.readdirSync(migrationsDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
} catch (_) {
  fail('migrations directory', 'cannot read ' + migrationsDir);
}
if (migrationFiles.length > 0) {
  pass('migrations directory — ' + migrationFiles.length + ' migration(s) found; latest: ' + migrationFiles[migrationFiles.length - 1]);
} else {
  fail('migrations directory', 'no migration files found');
}

// ---------------------------------------------------------------------------
// 3. Shutdown factory wiring (static require check)
// ---------------------------------------------------------------------------

console.log('\n[3/5] Runtime module checks\n');

try {
  const { buildShutdown, safeErrMeta } = require('../src/lifecycle/shutdown');
  if (typeof buildShutdown !== 'function') throw new Error('buildShutdown not exported');
  if (typeof safeErrMeta   !== 'function') throw new Error('safeErrMeta not exported');
  pass('lifecycle/shutdown — buildShutdown and safeErrMeta exported');
} catch (e) {
  fail('lifecycle/shutdown', e.message);
}

try {
  const { validateProductionEnv: vpe } = require('../src/config/envValidation');
  if (typeof vpe !== 'function') throw new Error('validateProductionEnv not exported');
  pass('config/envValidation — validateProductionEnv exported');
} catch (e) {
  fail('config/envValidation', e.message);
}

try {
  const { corsMiddleware } = require('../src/middleware/security');
  if (typeof corsMiddleware !== 'function') throw new Error('corsMiddleware not exported');
  pass('middleware/security — corsMiddleware exported');
} catch (e) {
  fail('middleware/security', e.message);
}

// ---------------------------------------------------------------------------
// 4. Database connectivity + migration state
// ---------------------------------------------------------------------------

console.log('\n[4/5] Database\n');

async function checkDatabase() {
  if (!env.DATABASE_URL) {
    warn('database', 'DATABASE_URL not set — skipping DB checks');
    return;
  }

  let pool;
  try {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  } catch (e) {
    fail('database connect', 'pg module error: ' + e.message);
    return;
  }

  let client;
  try {
    client = await pool.connect();
    pass('database connectivity');
  } catch (e) {
    fail('database connectivity', 'could not connect');
    await pool.end().catch(() => {});
    return;
  }

  try {
    // Role safety: must not be superuser or BYPASSRLS
    const roleRow = await client.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
    );
    if (roleRow.rows.length === 0) {
      warn('db role', 'current_user not found in pg_roles');
    } else {
      const { rolsuper, rolbypassrls } = roleRow.rows[0];
      if (rolsuper)      fail('db role', 'current role is SUPERUSER — RLS is bypassed');
      else               pass('db role is not superuser');
      if (rolbypassrls)  fail('db role', 'current role has BYPASSRLS — tenant isolation is bypassed');
      else               pass('db role does not have BYPASSRLS');
    }

    // Latest migration applied (schema_migrations.version is filename without .sql extension)
    if (migrationFiles.length > 0) {
      const latest = migrationFiles[migrationFiles.length - 1];
      const version = latest.replace(/\.sql$/, '');
      const migRow = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [version]
      );
      if (migRow.rowCount > 0) pass('latest migration applied: ' + latest);
      else                     fail('latest migration NOT applied: ' + latest);
    }

    // RLS FORCE on core tenant tables
    const RLS_TABLES = ['tenants', 'properties', 'users', 'reservations', 'rooms'];
    const rlsRows = await client.query(
      "SELECT relname, relrowsecurity, relforcerowsecurity " +
      "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
      "WHERE n.nspname = 'public' AND c.relkind = 'r' AND relname = ANY($1)",
      [RLS_TABLES]
    );
    const rlsMap = {};
    for (const r of rlsRows.rows) rlsMap[r.relname] = r;
    for (const tbl of RLS_TABLES) {
      const r = rlsMap[tbl];
      if (!r)                          warn('rls:' + tbl, 'table not found');
      else if (!r.relrowsecurity)      fail('rls:' + tbl, 'RLS not enabled');
      else if (!r.relforcerowsecurity) fail('rls:' + tbl, 'FORCE RLS not set — superuser writes bypass tenant isolation');
      else                             pass('rls:' + tbl + ' ENABLE + FORCE');
    }
  } catch (e) {
    fail('database checks', e.message);
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Summary (async tail — ensures DB section prints before runtime config)
// ---------------------------------------------------------------------------

checkDatabase().then(() => {
  // 5. Runtime configuration (printed after DB section is complete)
  console.log('\n[5/5] Runtime configuration\n');

  const raw = env.TRUST_PROXY;
  if (raw === 'true') {
    warn('TRUST_PROXY', '"true" (unbounded) allows X-Forwarded-For spoofing — prefer "1" or a numeric hop count');
  } else {
    pass('TRUST_PROXY = "' + raw + '"');
  }

  if (env.CORS_ORIGIN) pass('CORS_ORIGIN set: ' + env.CORS_ORIGIN);
  else                 warn('CORS_ORIGIN not set — CORS disabled (OK for same-origin deployments)');

  console.log('\n' + '─'.repeat(60));
  console.log('  passed:   ' + passed);
  console.log('  warnings: ' + warned);
  console.log('  failed:   ' + failed);
  console.log('─'.repeat(60));
  if (failed > 0) {
    console.error('\n  VERDICT: FAIL (' + failed + ' blocker(s) must be resolved before deploying)\n');
    process.exitCode = 1;
  } else if (warned > 0) {
    console.log('\n  VERDICT: PASS-WITH-NOTES (' + warned + ' warning(s) — review before deploying)\n');
  } else {
    console.log('\n  VERDICT: PASS — ready for production deployment\n');
  }
}).catch((e) => {
  console.error('\n  PREFLIGHT SCRIPT ERROR: ' + e.message);
  process.exitCode = 1;
});
