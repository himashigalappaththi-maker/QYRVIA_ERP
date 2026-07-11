'use strict';

/**
 * RLS guard — shared, side-effect-free checks that the DB connection is a
 * principal RLS can actually bind to, and that the schema's RLS posture is
 * intact. Used by BOTH the CI preflight gate (scripts/rls-preflight.js) and the
 * in-suite guard test (rls_guard.db.test.js) so the rule lives in one place.
 *
 * The cardinal rule: NEVER validate RLS on a superuser / BYPASSRLS connection.
 * Such a role silently bypasses Row-Level Security (FORCE included), so every
 * isolation assertion would be a false pass. If the connected role is superuser
 * or has BYPASSRLS, that is a hard failure — not a skip.
 */

const APPEND_ONLY_TABLES = ['audit_events', 'event_store', 'ledger_entries', 'payment_attempt_log', 'booking_confirmation_deliveries', 'user_invitations', 'password_reset_tokens'];
const RLS_FORCED_TABLES = ['tenants', 'properties', 'audit_events'];

/** Role attributes of the *current* connection. */
async function roleInfo(db) {
  const r = await db.query(
    `SELECT current_user AS role,
            current_setting('is_superuser') = 'on' AS is_superuser,
            COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS bypassrls`);
  return r.rows[0];
}

/**
 * Throw unless the connection is a NON-superuser, NON-BYPASSRLS role. This is
 * the single check that prevents superuser-based RLS testing from ever
 * re-entering the pipeline.
 */
async function assertRlsCapableRole(db) {
  const info = await roleInfo(db);
  if (info.is_superuser || info.bypassrls) {
    throw new Error(
      `RLS GUARD: connection role "${info.role}" is ` +
      `${info.is_superuser ? 'a SUPERUSER' : 'BYPASSRLS'} — RLS does not bind to it, ` +
      `so tenant isolation cannot be validated. Point TEST_DATABASE_URL at a ` +
      `NON-superuser, NON-BYPASSRLS role (e.g. qyrvia_test).`);
  }
  return info;
}

/**
 * COMPREHENSIVE: every base table that has a `tenant_id` column MUST have
 * ENABLE + FORCE row level security AND at least one policy that references
 * `app.tenant_id`. This is the regression lock — a future migration that adds a
 * tenant-scoped table but forgets RLS (or writes a policy that doesn't bind
 * app.tenant_id) fails here, in CI, before it can ship. Returns the count of
 * tenant tables checked.
 */
async function assertAllTenantTablesSecured(db) {
  const r = await db.query(`
    SELECT c.relname AS tbl, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
      (SELECT count(*)::int FROM pg_policies p
         WHERE p.schemaname='public' AND p.tablename=c.relname
           AND (
             (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,'')) LIKE '%app.tenant_id%'
             OR (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,'')) LIKE '%app_current_tenant%'
           )) AS app_policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND EXISTS (SELECT 1 FROM information_schema.columns col
                  WHERE col.table_schema='public' AND col.table_name=c.relname AND col.column_name='tenant_id')
    ORDER BY c.relname`);
  const gaps = r.rows.filter((x) => !x.enabled || !x.forced || x.app_policies === 0);
  if (gaps.length) {
    throw new Error('RLS GUARD: tenant-scoped tables missing ENABLE+FORCE RLS or an app.tenant_id policy: ' +
      gaps.map((g) => `${g.tbl}(enabled=${g.enabled},forced=${g.forced},appPolicies=${g.app_policies})`).join(', '));
  }
  if (r.rows.length === 0) {
    throw new Error('RLS GUARD: no tenant-scoped tables found — schema not provisioned/migrated');
  }
  return r.rows.length;
}

/** Throw if PUBLIC holds ANY table privilege in public (tenant tables must not be world-accessible). */
async function assertNoPublicTableGrants(db) {
  const r = await db.query(`
    SELECT table_name, privilege_type FROM information_schema.role_table_grants
     WHERE table_schema='public' AND grantee='PUBLIC'
       AND privilege_type IN ('INSERT','UPDATE','DELETE','SELECT','TRUNCATE')
     ORDER BY table_name, privilege_type`);
  if (r.rows.length) {
    throw new Error('RLS GUARD: PUBLIC must not hold table privileges, found: ' +
      r.rows.map((x) => x.table_name + ':' + x.privilege_type).join(', '));
  }
}

/** Throw unless ENABLE + FORCE row level security is set on the core tenant tables. */
async function assertForceRls(db) {
  const r = await db.query(
    `SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1)`, [RLS_FORCED_TABLES]);
  const byName = Object.fromEntries(r.rows.map((x) => [x.relname, x]));
  for (const t of RLS_FORCED_TABLES) {
    const row = byName[t];
    if (!row) throw new Error(`RLS GUARD: table "${t}" missing — schema not provisioned/migrated`);
    if (!row.enabled || !row.forced) {
      throw new Error(`RLS GUARD: table "${t}" must have ENABLE+FORCE ROW LEVEL SECURITY ` +
        `(enabled=${row.enabled}, forced=${row.forced})`);
    }
  }
}

/** Throw if PUBLIC still holds UPDATE/DELETE on the append-only tables. */
async function assertAppendOnlyRevoked(db) {
  for (const t of APPEND_ONLY_TABLES) {
    for (const priv of ['UPDATE', 'DELETE']) {
      const r = await db.query(`SELECT has_table_privilege('public', $1, $2) AS p`, [t, priv]);
      if (r.rows[0].p) {
        throw new Error(`RLS GUARD: PUBLIC must NOT have ${priv} on append-only table "${t}"`);
      }
    }
  }
}

module.exports = {
  APPEND_ONLY_TABLES,
  RLS_FORCED_TABLES,
  roleInfo,
  assertRlsCapableRole,
  assertAllTenantTablesSecured,
  assertNoPublicTableGrants,
  assertForceRls,
  assertAppendOnlyRevoked
};
