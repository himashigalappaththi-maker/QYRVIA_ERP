'use strict';

/**
 * CI one-time provisioning (runs as the postgres superuser, OUTSIDE test
 * runtime): create the NON-superuser application role the DB tests connect as,
 * and give it ownership of the schema so it can run migrations and own the
 * tables (FORCE RLS then binds it). This is the only place a superuser is used,
 * and it is used ONLY to set up the restricted role — never to test RLS.
 *
 * Env:
 *   SUPERUSER_DATABASE_URL  postgres superuser connection (e.g. the CI service)
 *   APP_ROLE                role to create        (default: qyrvia_test)
 *   APP_ROLE_PASSWORD       password for the role (required)
 *
 * The created role is explicitly NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE.
 */

const { Pool } = require('pg');

const SU_URL = process.env.SUPERUSER_DATABASE_URL;
const ROLE = process.env.APP_ROLE || 'qyrvia_test';
const PW = process.env.APP_ROLE_PASSWORD;

if (!SU_URL) { console.error('ci-provision-db: SUPERUSER_DATABASE_URL is required'); process.exit(1); }
if (!PW) { console.error('ci-provision-db: APP_ROLE_PASSWORD is required'); process.exit(1); }
if (!/^[a-z_][a-z0-9_]*$/.test(ROLE)) { console.error('ci-provision-db: invalid APP_ROLE'); process.exit(1); }

(async () => {
  const su = new Pool({ connectionString: SU_URL });
  const dbName = (new URL(SU_URL).pathname || '/').slice(1) || 'postgres';
  try {
    // Idempotent role creation. Password is set separately (parameterised-safe
    // via format) so re-runs always converge to the configured password.
    await su.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
          CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        END IF;
        ALTER ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END $$;`);
    await su.query(`ALTER ROLE ${ROLE} PASSWORD '${PW.replace(/'/g, "''")}'`);

    // Ownership + privileges so the role can migrate and own the resulting tables.
    await su.query(`ALTER DATABASE ${dbName} OWNER TO ${ROLE}`);
    await su.query('ALTER SCHEMA public OWNER TO ' + ROLE);
    await su.query(`GRANT ALL ON SCHEMA public TO ${ROLE}`);
    await su.query(`GRANT ALL ON DATABASE ${dbName} TO ${ROLE}`);

    // Sanity: the role must NOT be superuser/bypassrls (else RLS would not bind).
    const chk = await su.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
    const r = chk.rows[0];
    if (!r || r.rolsuper || r.rolbypassrls) {
      throw new Error(`provisioned role ${ROLE} must be NOSUPERUSER + NOBYPASSRLS (got ${JSON.stringify(r)})`);
    }
    console.log(`✔ provisioned non-superuser role "${ROLE}" (owner of database "${dbName}")`);
  } catch (e) {
    console.error('✖ ci-provision-db failed:', e.message);
    process.exit(1);
  } finally {
    await su.end().catch(() => {});
  }
})();
