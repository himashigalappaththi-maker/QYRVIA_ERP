#!/usr/bin/env node
'use strict';

/**
 * One-shot CLI to migrate the frontend localStorage `gk_users` records to
 * backend-managed `users` rows.
 *
 * Usage:
 *   node src/scripts/migrate-gk-users.js \
 *     --tenant-code <tenant_code> \
 *     --input <path/to/gk_users.json>
 *
 * Input shape (mirrors the frontend `localStorage["gk_users"]` JSON):
 *   [
 *     { id, name, username, password, role, department, createdAt },
 *     ...
 *   ]
 *
 * Behaviour:
 *   - Looks up the tenant by code. Refuses if not found.
 *   - For each user:
 *       1. bcrypt-hashes the plaintext password
 *       2. INSERTs into `users` (idempotent on (tenant_id, username))
 *       3. Maps legacy role string -> seeded role code via LEGACY_ROLE_MAP
 *       4. INSERTs the user_roles row (idempotent)
 *       5. Emits audit_event `user.migrated_from_localstorage`
 *   - Re-runs are safe (idempotent ON CONFLICT DO NOTHING throughout).
 *
 * After running, the operator should clear `localStorage["gk_users"]` on
 * each browser that had the data.
 */

const fs   = require('fs');
const path = require('path');
const env  = require('../config/env');
const logger = require('../config/logger');
const db   = require('../db/client');
const identity = require('../services/identity');
const { makeEvent } = require('../core/event');

const LEGACY_ROLE_MAP = {
  // legacy frontend role string  ->  seeded backend role code
  'super_admin':         'super_admin',
  'superadmin':          'super_admin',
  'admin':               'corporate_admin',
  'property_admin':      'property_admin',
  'gm':                  'corporate_admin',
  'general_manager':     'corporate_admin',
  'director':            'corporate_admin',
  'finance_manager':     'finance_manager',
  'front_desk_manager':  'front_office_manager',
  'front_office_manager':'front_office_manager',
  'hr_manager':          'hr_manager',
  'hr_officer':          'hr_manager',
  'hod':                 'department_head',
  'department_head':     'department_head',
  'inventory_manager':   'inventory_manager',
  'storekeeper':         'inventory_manager',
  'procurement':         'inventory_manager',
  'revenue_manager':     'front_office_manager',
  'reception':           'staff',
  'front_desk':          'staff',
  'housekeeping':        'staff',
  'sales_manager':       'staff',
  'staff':               'staff'
};

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant-code') out.tenantCode = argv[++i];
    else if (a === '--input')  out.input      = argv[++i];
    else if (a === '--dry-run') out.dryRun    = true;
  }
  if (!out.tenantCode || !out.input) {
    console.error('usage: node src/scripts/migrate-gk-users.js --tenant-code <code> --input <path> [--dry-run]');
    process.exit(2);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const raw  = fs.readFileSync(path.resolve(args.input), 'utf8');
  let records;
  try { records = JSON.parse(raw); }
  catch (e) { console.error('input is not valid JSON: ' + e.message); process.exit(2); }
  if (!Array.isArray(records)) { console.error('input must be a JSON array'); process.exit(2); }

  const t = await db.pool.query(`SELECT id, status FROM tenants WHERE code = $1 LIMIT 1`, [args.tenantCode]);
  if (!t.rows[0]) { console.error('tenant not found: ' + args.tenantCode); process.exit(1); }
  if (t.rows[0].status !== 'active') { console.error('tenant not active: ' + args.tenantCode); process.exit(1); }
  const tenantId = t.rows[0].id;

  let created = 0, skipped = 0, failed = 0;
  for (const r of records) {
    const username = String(r.username || '').trim();
    const password = String(r.password || '');
    const fullName = String(r.name || username || 'Unknown');
    const legacyRole = String(r.role || 'staff').toLowerCase();
    const mappedRole = LEGACY_ROLE_MAP[legacyRole] || 'staff';

    if (!username || !password) {
      console.warn('[skip] missing username or password: ' + JSON.stringify({ username }));
      skipped++; continue;
    }

    try {
      if (args.dryRun) {
        console.log('[dry] would create: ' + username + ' -> ' + mappedRole);
        created++; continue;
      }
      const hash = await identity.hashPassword(password);

      // Idempotent insert
      const insert = await db.pool.query(
        `INSERT INTO users (tenant_id, username, password_hash, full_name, status)
         VALUES ($1,$2,$3,$4,'ACTIVE'::user_status)
         ON CONFLICT (tenant_id, username) DO NOTHING
         RETURNING id`,
        [tenantId, username, hash, fullName]
      );
      let userId;
      if (insert.rows[0]) {
        userId = insert.rows[0].id;
        created++;
      } else {
        const ex = await db.pool.query(
          `SELECT id FROM users WHERE tenant_id = $1 AND username = $2`,
          [tenantId, username]
        );
        userId = ex.rows[0].id;
        skipped++;
      }

      await db.pool.query(
        `INSERT INTO user_roles (user_id, role_id, tenant_id)
         SELECT $1, r.id, $2 FROM roles r WHERE r.code = $3
         ON CONFLICT DO NOTHING`,
        [userId, tenantId, mappedRole]
      );

      // Audit row (best-effort; no app.tenant_id session var here, RLS may hide it)
      try {
        const ev = makeEvent({
          type:          'user.migrated_from_localstorage',
          aggregateType: 'user',
          aggregateId:   userId,
          payload:       { username, legacy_role: legacyRole, mapped_role: mappedRole },
          ctx: { tenantId: tenantId, requestId: 'migrate-cli-' + Date.now(), actorId: null, propertyId: null }
        });
        await db.pool.query(
          `INSERT INTO audit_events (event_id, event_type, aggregate_type, aggregate_id,
            tenant_id, property_id, actor_id, request_id, payload, occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [ev.event_id, ev.event_type, ev.aggregate_type, ev.aggregate_id,
           ev.tenant_id, ev.property_id, ev.actor_id, ev.request_id, ev.payload, ev.occurred_at]
        );
      } catch (e) { console.warn('[audit] skipped: ' + e.message); }

    } catch (err) {
      console.error('[fail] ' + username + ': ' + err.message);
      failed++;
    }
  }

  console.log('---');
  console.log('tenant: ' + args.tenantCode);
  console.log('input records: ' + records.length);
  console.log('created: ' + created);
  console.log('skipped (already present): ' + skipped);
  console.log('failed:  ' + failed);
  if (args.dryRun) console.log('(dry-run; no changes written)');
}

main().then(() => db.close()).catch(async (e) => {
  console.error(e);
  await db.close();
  process.exit(1);
});
