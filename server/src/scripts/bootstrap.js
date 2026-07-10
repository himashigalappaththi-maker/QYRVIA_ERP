#!/usr/bin/env node
'use strict';

/**
 * QYRVIA first-install bootstrap.
 *
 * Creates on an EMPTY database:
 *   - first tenant
 *   - first property
 *   - first super_admin user (with the super_admin role grant)
 *   - a small set of system settings
 *
 * Idempotent: if any of the above already exists (by code/username),
 * skip the create. Re-running is safe.
 *
 * Usage:
 *   node src/scripts/bootstrap.js \
 *     --tenant-code      TENANT-A \
 *     --tenant-name      "Acme Hospitality" \
 *     --property-code    AGH-COL \
 *     --property-name    "Acme Garden Hotel - Colombo" \
 *     --property-city    Colombo \
 *     --admin-username   admin \
 *     --admin-fullname   "System Admin" \
 *     --admin-password   "ChangeMe!2026"
 */

const env       = require('../config/env');
const logger    = require('../config/logger');
const db        = require('../db/client');
const identity  = require('../services/identity');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; }
    else { out[key] = next; i++; }
  }
  return out;
}

async function findTenantByCode(code) {
  const r = await db.pool.query(`SELECT * FROM tenants WHERE code=$1 LIMIT 1`, [code]);
  return r.rows[0] || null;
}
async function insertTenant({ code, name }) {
  const r = await db.pool.query(
    `INSERT INTO tenants (code, name, status) VALUES ($1, $2, 'active') RETURNING *`,
    [code, name]
  );
  return r.rows[0];
}
async function findPropertyByCode(tenantId, code) {
  const r = await db.pool.query(`SELECT * FROM properties WHERE tenant_id=$1 AND code=$2 LIMIT 1`, [tenantId, code]);
  return r.rows[0] || null;
}
async function insertProperty(rec) {
  const r = await db.pool.query(
    `INSERT INTO properties (tenant_id, code, name, city, currency, active) VALUES ($1,$2,$3,$4,$5,true) RETURNING *`,
    [rec.tenant_id, rec.code, rec.name, rec.city || null, rec.currency || 'LKR']
  );
  return r.rows[0];
}
async function findUserByUsername(tenantId, username) {
  const r = await db.pool.query(
    `SELECT * FROM users WHERE tenant_id=$1 AND username=$2 AND soft_deleted_at IS NULL LIMIT 1`,
    [tenantId, username]
  );
  return r.rows[0] || null;
}
async function insertUserSuper(rec) {
  const r = await db.pool.query(
    `INSERT INTO users (tenant_id, username, password_hash, full_name, primary_property_id, status)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE'::user_status) RETURNING *`,
    [rec.tenant_id, rec.username, rec.password_hash, rec.full_name, rec.primary_property_id || null]
  );
  return r.rows[0];
}
async function grantSuperAdmin(userId, tenantId) {
  // super_admin role exists from 0003_seed_roles.sql; tenant_id is required by user_roles
  await db.pool.query(
    `INSERT INTO user_roles (user_id, role_id, tenant_id)
     SELECT $1, r.id, $2 FROM roles r WHERE r.code='super_admin'
     ON CONFLICT DO NOTHING`,
    [userId, tenantId]
  );
}

async function ensureSetting(tenantId, category, key, valueJson, actorId) {
  await db.pool.query(
    `INSERT INTO settings (tenant_id, category, key, value_json, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, COALESCE(property_id, '00000000-0000-0000-0000-000000000000'::uuid), category, key)
     DO NOTHING`,
    [tenantId, category, key, valueJson, actorId]
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const required = ['tenant_code','tenant_name','property_code','property_name','admin_username','admin_fullname','admin_password'];
  const missing  = required.filter((k) => !args[k]);
  if (missing.length) {
    console.error('bootstrap: missing required --' + missing.join(' --').replace(/_/g,'-'));
    process.exit(2);
  }
  if (String(args.admin_password).length < 8) {
    console.error('bootstrap: admin password must be 8+ chars');
    process.exit(2);
  }
  logger.info({ tenant_code: args.tenant_code, property_code: args.property_code }, '[bootstrap] starting');

  // 1. tenant
  let tenant = await findTenantByCode(args.tenant_code);
  if (!tenant) { tenant = await insertTenant({ code: args.tenant_code, name: args.tenant_name }); logger.info({ id: tenant.id }, '[bootstrap] tenant created'); }
  else { logger.info({ id: tenant.id }, '[bootstrap] tenant exists, skipping'); }

  // 1a. Ensure hold-expiry sweep job exists for this tenant (Phase 56 gap closure).
  //     WHERE NOT EXISTS makes this idempotent: re-running bootstrap never creates
  //     a duplicate. The uq_scheduled_jobs_active_per_tenant_type index (migration
  //     0070) provides an additional DB-level uniqueness guard.
  await db.pool.query(
    `INSERT INTO scheduled_jobs
       (tenant_id, property_id, job_type, payload, run_at,
        recurrence_rule, timezone, next_run_at, max_attempts)
     SELECT $1, NULL, 'booking.hold.expire_sweep', '{}'::jsonb, now(),
            '*/5 * * * *', 'UTC', now(), 3
     WHERE NOT EXISTS (
       SELECT 1 FROM scheduled_jobs sj
        WHERE sj.tenant_id = $1
          AND sj.job_type  = 'booking.hold.expire_sweep'
     )`,
    [tenant.id]
  );
  logger.info({ tenant_id: tenant.id }, '[bootstrap] hold-expiry sweep job ensured');

  // 2. property
  let property = await findPropertyByCode(tenant.id, args.property_code);
  if (!property) {
    property = await insertProperty({
      tenant_id: tenant.id, code: args.property_code, name: args.property_name,
      city: args.property_city, currency: args.currency
    });
    logger.info({ id: property.id }, '[bootstrap] property created');
  } else { logger.info({ id: property.id }, '[bootstrap] property exists, skipping'); }

  // 3. super admin user
  let user = await findUserByUsername(tenant.id, args.admin_username);
  if (!user) {
    const password_hash = await identity.hashPassword(args.admin_password);
    user = await insertUserSuper({
      tenant_id: tenant.id, username: args.admin_username,
      password_hash, full_name: args.admin_fullname,
      primary_property_id: property.id
    });
    logger.info({ id: user.id }, '[bootstrap] admin created');
  } else {
    logger.info({ id: user.id }, '[bootstrap] admin exists, skipping create');
  }
  await grantSuperAdmin(user.id, tenant.id);
  logger.info({ user: user.id }, '[bootstrap] super_admin role ensured');

  // 4. system settings (tenant-wide defaults)
  await ensureSetting(tenant.id, 'system', 'currency',    { value: args.currency || 'LKR' }, user.id);
  await ensureSetting(tenant.id, 'system', 'timezone',    { value: 'UTC' },                  user.id);
  await ensureSetting(tenant.id, 'system', 'date_format', { value: 'YYYY-MM-DD' },           user.id);
  await ensureSetting(tenant.id, 'auth',   'jwt_ttl_sec', { value: env.ACCESS_TOKEN_TTL_SEC }, user.id);
  logger.info('[bootstrap] system settings ensured');

  logger.info({
    tenant_code: args.tenant_code,
    property_code: args.property_code,
    admin: args.admin_username
  }, '[bootstrap] complete');
}

main()
  .then(() => db.close())
  .catch(async (err) => {
    logger.error({ err }, '[bootstrap] failed');
    await db.close();
    process.exit(1);
  });
