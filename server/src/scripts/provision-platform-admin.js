#!/usr/bin/env node
'use strict';

/**
 * provision-platform-admin.js
 *
 * Idempotent bootstrap for the initial QYRVIA Platform Super Admin account.
 *
 * SECURITY RULES (enforced here — never bypass):
 *   - Email and password are read ONLY from environment variables or CLI args.
 *   - They are NEVER hard-coded, logged, or written to any file.
 *   - The password is hashed with bcrypt before database storage.
 *   - Re-running after the user has set their own password (status=ACTIVE)
 *     does NOT overwrite the password — only the super_admin role is re-ensured.
 *   - All provisioning actions are written to audit_events (non-fatal).
 *
 * Usage:
 *   QYRVIA_BOOTSTRAP_SUPER_ADMIN_EMAIL=<email> \
 *   QYRVIA_BOOTSTRAP_SUPER_ADMIN_PASSWORD=<password> \
 *     node src/scripts/provision-platform-admin.js
 *
 * Flags (override env vars):
 *   --email    <email>       Admin email
 *   --password <password>    Bootstrap password (min 8 chars)
 *   --fullname <Full Name>   Display name (default: Platform Super Admin)
 *   --tenant-code <code>     Platform tenant code (default: QYRVIA-PLATFORM)
 *   --tenant-name <name>     Platform tenant name (default: QYRVIA Platform Operations)
 *
 * Idempotency:
 *   - User already ACTIVE            → password unchanged; super_admin role ensured.
 *   - User already PENDING_PASSWORD_RESET → password unchanged; role ensured.
 *   - User doesn't exist             → created with hashed password + PENDING_PASSWORD_RESET.
 *
 * First-login flow:
 *   1. Log in at POST /api/auth/login with { email, password }.
 *   2. Response includes { requires_password_change: true, password_reset_token: "<token>" }.
 *   3. POST /api/auth/password-reset/complete with { token, new_password }.
 *   4. After that, only the new password authenticates. The bootstrap password is gone.
 */

const crypto = require('node:crypto');
const db     = require('../db/client');
const { bootstrapPlatformAdmin } = require('../services/platformBootstrap');
const logger = require('../config/logger');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

async function ensureTenant({ code, name }) {
  let r = await db.pool.query(`SELECT * FROM tenants WHERE code=$1 LIMIT 1`, [code]);
  if (r.rows[0]) return r.rows[0];
  r = await db.pool.query(
    `INSERT INTO tenants (code, name, status) VALUES ($1, $2, 'active') RETURNING *`,
    [code, name]
  );
  logger.info({ id: r.rows[0].id, code }, '[provision] platform tenant created');
  return r.rows[0];
}

async function main() {
  const args     = parseArgs(process.argv);
  const email    = args.email    || process.env.QYRVIA_BOOTSTRAP_SUPER_ADMIN_EMAIL;
  const password = args.password || process.env.QYRVIA_BOOTSTRAP_SUPER_ADMIN_PASSWORD;

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) {
    console.error('[provision] ERROR: valid email required via --email or QYRVIA_BOOTSTRAP_SUPER_ADMIN_EMAIL');
    process.exit(2);
  }
  if (!password || String(password).length < 8) {
    console.error('[provision] ERROR: password (min 8 chars) required via --password or QYRVIA_BOOTSTRAP_SUPER_ADMIN_PASSWORD');
    process.exit(2);
  }

  const tenantCode = args.tenant_code || 'QYRVIA-PLATFORM';
  const tenantName = args.tenant_name || 'QYRVIA Platform Operations';
  const fullName   = args.fullname    || 'Platform Super Admin';

  logger.info({ tenantCode }, '[provision] starting platform super admin provisioning');

  const tenant = await ensureTenant({ code: tenantCode, name: tenantName });

  // Build a DB-backed repo adapter for bootstrapPlatformAdmin
  const repo = {
    async findUserByEmailGlobal(em) {
      const r = await db.pool.query(
        `SELECT * FROM users WHERE lower(email)=lower($1) AND soft_deleted_at IS NULL LIMIT 1`, [em]
      );
      return r.rows[0] || null;
    },
    async insertUser(rec) {
      const r = await db.pool.query(
        `INSERT INTO users (tenant_id, username, email, password_hash, full_name, status)
         VALUES ($1,$2,$3,$4,$5,$6::user_status) RETURNING *`,
        [rec.tenant_id, rec.username, rec.email, rec.password_hash, rec.full_name, rec.status]
      );
      return r.rows[0];
    },
    async ensureSuperAdminRole(userId, tenantId) {
      await db.pool.query(
        `INSERT INTO user_roles (user_id, role_id, tenant_id)
         SELECT $1, r.id, $2 FROM roles r WHERE r.code='super_admin'
         ON CONFLICT DO NOTHING`,
        [userId, tenantId]
      );
    },
    async insertAuditEvent(ev) {
      await db.pool.query(
        `INSERT INTO audit_events
           (tenant_id, event_type, aggregate_type, aggregate_id, actor_id, request_id, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [ev.tenant_id, ev.event_type, ev.aggregate_type, ev.aggregate_id,
         ev.actor_id, crypto.randomUUID(), ev.payload]
      );
    }
  };

  const result = await bootstrapPlatformAdmin({
    email, password, fullName, tenantId: tenant.id
  }, repo);

  if (!result.ok) {
    console.error('[provision] ERROR:', result.error);
    process.exit(2);
  }

  console.log('\n========================================================');
  console.log('  QYRVIA Platform Super Admin — provisioning complete');
  console.log('========================================================');
  console.log('  Email    :', result.email);
  console.log('  User ID  :', result.userId);
  console.log('  Tenant   :', tenant.code, '(' + tenant.id + ')');
  console.log('  Status   :', result.status);
  console.log('  Action   :', result.action);
  if (result.action === 'created' || result.action === 'pending_first_login') {
    console.log('\n  Next step: log in at POST /api/auth/login with');
    console.log('  { "email": "' + result.email + '", "password": "<bootstrap-password>" }');
    console.log('  The response will include a one-time password_reset_token.');
    console.log('  Use it at POST /api/auth/password-reset/complete to set your permanent password.');
  } else {
    console.log('\n  Account is active. Log in with your existing password.');
  }
  console.log('========================================================\n');

  logger.info({ userId: result.userId, action: result.action }, '[provision] complete');
}

main()
  .then(() => db.close())
  .catch(async (err) => {
    logger.error({ err }, '[provision] failed');
    await db.close();
    process.exit(1);
  });
