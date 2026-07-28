'use strict';

/* ===========================================================================
 * Phase 66A-B2A — GUARDED READ-ONLY WORKER-RESOLVER METADATA PROBE
 * ===========================================================================
 *
 * WHAT THIS IS
 *
 *   A read-only reconnaissance tool. It answers exactly one question:
 *
 *     "Is the local qyrvia_test database in the expected PRE-BOOTSTRAP state,
 *      so that phase66a_worker_resolvers_bootstrap.sql may safely be run?"
 *
 *   It reads system catalogs only. It never reads a business row, never writes,
 *   and cannot write: every statement runs inside a READ ONLY transaction that
 *   is verified as read-only before any metadata query is issued, and rolled
 *   back unconditionally afterwards.
 *
 * WHAT THIS IS NOT
 *
 *   It is NOT the bootstrap. It installs nothing, grants nothing, and owns
 *   nothing. It is never imported by application code, migrations, package
 *   scripts or test bootstrapping — it runs only when a human invokes it
 *   directly.
 *
 * HOW TO RUN IT (a human does this; nothing automated calls it)
 *
 *   Supply the target through the process environment only. Never on the
 *   command line, never in a file inside this repository.
 *
 *     TEST_DATABASE_URL=<url for 127.0.0.1:5432/qyrvia_test> \
 *       node server/scripts/db/phase66a_readonly_metadata_probe.js
 *
 *   The URL is read once, validated, and never printed, logged or echoed —
 *   not on success, not on failure, not inside an error.
 *
 * SECURITY BOUNDARY
 *
 *   1. Target guard runs BEFORE the PostgreSQL driver is even loaded. A
 *      rejected target means `pg` is never required and no socket is opened.
 *   2. The target must be EXACTLY 127.0.0.1:5432/qyrvia_test. Not localhost,
 *      not ::1, not another port, not another database, no connection options.
 *   3. After connecting, the session must prove it is read-only, and the SERVER
 *      must confirm it is the expected host, port and database — a correct URL
 *      pointed at a tunnel or a proxy is still rejected here.
 *   4. Every SQL statement is a static literal. There is no interpolation, no
 *      concatenation, no caller-supplied SQL and no dynamic identifier.
 *   5. Output is a single sanitized JSON object. Errors are fixed category
 *      strings plus an optional PostgreSQL SQLSTATE. Driver messages, stack
 *      traces and connection parameters never reach stdout or stderr.
 *
 * EXIT CODES
 *
 *   0  pre-bootstrap state verified valid
 *   1  any guard failure, connection failure, or invalid pre-bootstrap state
 * =========================================================================== */

/* ---------------------------------------------------------------------------
 * Fixed, safe error identifiers. These are the ONLY strings this probe emits
 * to describe a failure. None of them can carry a value from the environment,
 * the URL or the driver.
 * ------------------------------------------------------------------------- */
const ERR = {
  // configuration / target guard
  URL_REQUIRED:   'TEST_DATABASE_URL_REQUIRED',
  URL_INVALID:    'TEST_DATABASE_URL_INVALID',
  HOST:           'DATABASE_HOST_NOT_ALLOWED',
  PORT:           'DATABASE_PORT_NOT_ALLOWED',
  NAME:           'DATABASE_NAME_NOT_ALLOWED',
  OPTIONS:        'DATABASE_OPTIONS_NOT_ALLOWED',
  // post-connection identity guard
  READ_ONLY:      'READ_ONLY_TRANSACTION_REQUIRED',
  CONN_DB:        'CONNECTED_DATABASE_NOT_ALLOWED',
  CONN_HOST:      'CONNECTED_HOST_NOT_ALLOWED',
  CONN_PORT:      'CONNECTED_PORT_NOT_ALLOWED',
};

/* Stderr categories. Fixed strings only. */
const CAT = {
  CONFIG:    'PROBE_CONFIGURATION_ERROR',
  CONNECT:   'PROBE_CONNECTION_ERROR',
  READ_ONLY: 'PROBE_READ_ONLY_ERROR',
  METADATA:  'PROBE_METADATA_ERROR',
  CLEANUP:   'PROBE_CLEANUP_ERROR',
  INVALID:   'PROBE_STATE_INVALID',
};

const PROBE_VERSION = 'phase66a-b2a.1';

/* The one and only permitted target. Literals, not configuration. */
const ALLOWED_HOST = '127.0.0.1';
const ALLOWED_PORT = 5432;
const ALLOWED_DB   = 'qyrvia_test';

/* The three roles this probe is allowed to describe. */
const RUNTIME_ROLE      = 'qyrvia_test';
const RESOLVER_ROLE     = 'qyrvia_auth_resolver';
const SCHEMA_OWNER_ROLE = 'qyrvia_auth_schema_owner';

/* ---------------------------------------------------------------------------
 * A ProbeError carries a fixed identifier and, at most, a PostgreSQL SQLSTATE.
 * It deliberately has no place to put a driver message, so one cannot leak by
 * accident later.
 * ------------------------------------------------------------------------- */
class ProbeError extends Error {
  constructor(category, code, pgCode) {
    super(code);
    this.name = 'ProbeError';
    this.category = category;
    this.code = code;
    this.pgCode = pgCode || null;
  }
}

/* SQLSTATE is a fixed 5-character alphanumeric class code — it contains no
 * user data, no hostname and no credential. Anything that is not exactly that
 * shape is discarded rather than echoed. */
function safePgCode(err) {
  const c = err && err.code;
  return (typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c)) ? c : null;
}

/* ===========================================================================
 * 1. TARGET GUARD — runs before `pg` is loaded
 * ========================================================================= */

function resolveTarget() {
  const raw = process.env.TEST_DATABASE_URL;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ProbeError(CAT.CONFIG, ERR.URL_REQUIRED, null);
  }

  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    // The unparsable value is never included — only the fixed identifier.
    throw new ProbeError(CAT.CONFIG, ERR.URL_INVALID, null);
  }

  // Protocol must be a PostgreSQL scheme.
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ProbeError(CAT.CONFIG, ERR.URL_INVALID, null);
  }

  // A username must be present. Its value is never inspected beyond emptiness,
  // and never reported.
  if (!url.username) {
    throw new ProbeError(CAT.CONFIG, ERR.URL_INVALID, null);
  }
  // Password presence is evaluated as a boolean and immediately discarded. It
  // is deliberately NOT stored and NOT reported.
  void (url.password.length > 0);

  // A fragment can hide a second target from a naive parser.
  if (url.hash) {
    throw new ProbeError(CAT.CONFIG, ERR.OPTIONS, null);
  }

  // Any query parameter at all is refused. This is stricter than denylisting
  // sslmode/service/host/port/options individually, and cannot be outflanked
  // by a parameter name nobody thought of.
  if (url.search && url.search.length > 0) {
    throw new ProbeError(CAT.CONFIG, ERR.OPTIONS, null);
  }
  if (url.searchParams && Array.from(url.searchParams.keys()).length > 0) {
    throw new ProbeError(CAT.CONFIG, ERR.OPTIONS, null);
  }

  // Host: exactly the loopback literal. `localhost` is refused because its
  // resolution is controlled by the hosts file and the resolver, not by us.
  // `::1`, bare hostnames, and comma-separated multi-host lists all fail here.
  const hostname = url.hostname;
  if (hostname !== ALLOWED_HOST) {
    throw new ProbeError(CAT.CONFIG, ERR.HOST, null);
  }
  if (hostname.indexOf(',') !== -1) {
    throw new ProbeError(CAT.CONFIG, ERR.HOST, null);
  }

  // Port: must be present and exactly 5432. An absent port is refused rather
  // than defaulted, so a Unix-socket or implicit target cannot slip through.
  if (url.port !== String(ALLOWED_PORT)) {
    throw new ProbeError(CAT.CONFIG, ERR.PORT, null);
  }

  // Database: exactly /qyrvia_test, with no extra path segment.
  if (url.pathname !== '/' + ALLOWED_DB) {
    throw new ProbeError(CAT.CONFIG, ERR.NAME, null);
  }

  return raw;
}

/* ===========================================================================
 * 2. STATIC SQL — every statement below is a literal constant
 * ========================================================================= */

const SQL_BEGIN_READ_ONLY = 'BEGIN READ ONLY';
const SQL_ROLLBACK        = 'ROLLBACK';
const SQL_SHOW_READ_ONLY  = 'SHOW transaction_read_only';

/* host() strips the network mask. Casting inet straight to text keeps it, so a
 * loopback server renders as 127.0.0.1/32 and can never equal ALLOWED_HOST.
 * This normalises the representation only — the permitted host is unchanged. */
const SQL_IDENTITY = `
  SELECT current_database()          AS database_name,
         current_user                AS current_user_name,
         session_user                AS session_user_name,
         pg_catalog.host(pg_catalog.inet_server_addr()) AS server_host,
         inet_server_port()          AS server_port
`;

const SQL_CONNECTED_ROLE = `
  SELECT r.rolsuper     AS is_superuser,
         r.rolbypassrls AS bypassrls
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = current_user
`;

const SQL_EXPECTED_ROLES = `
  SELECT r.rolname      AS role_name,
         r.rolcanlogin  AS can_login,
         r.rolsuper     AS is_superuser,
         r.rolbypassrls AS bypassrls
    FROM pg_catalog.pg_roles r
   WHERE r.rolname IN ('qyrvia_test', 'qyrvia_auth_resolver', 'qyrvia_auth_schema_owner')
   ORDER BY r.rolname
`;

const SQL_ROLE_MEMBERSHIPS = `
  SELECT m.rolname AS member_role,
         g.rolname AS granted_role
    FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles m ON m.oid = am.member
    JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
   WHERE g.rolname IN ('qyrvia_auth_resolver', 'qyrvia_auth_schema_owner')
     AND (m.rolname IN ('qyrvia_test', 'qyrvia_auth_resolver', 'qyrvia_auth_schema_owner')
          OR m.rolname = current_user)
   ORDER BY m.rolname, g.rolname
`;

const SQL_SOURCE_TABLES = `
  SELECT n.nspname              AS schema_name,
         c.relname              AS table_name,
         o.rolname              AS owner,
         c.relrowsecurity       AS rls_enabled,
         c.relforcerowsecurity  AS force_rls
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_roles     o ON o.oid = c.relowner
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname IN ('channel_sync_queue_store', 'scheduled_jobs')
   ORDER BY c.relname
`;

const SQL_WORKER_SCHEMA = `
  SELECT n.nspname AS schema_name,
         o.rolname AS owner
    FROM pg_catalog.pg_namespace n
    JOIN pg_catalog.pg_roles     o ON o.oid = n.nspowner
   WHERE n.nspname = 'worker_resolvers'
`;

const SQL_WORKER_OBJECT_COUNT = `
  SELECT count(*)::int AS object_count
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'worker_resolvers'
`;

const SQL_WORKER_FUNCTIONS = `
  SELECT p.proname                       AS function_name,
         o.rolname                       AS owner,
         p.prosecdef                     AS security_definer,
         p.provolatile                   AS volatility_code,
         t.typname                       AS return_type,
         (p.proconfig::text LIKE '%search_path=%') AS fixed_search_path,
         pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')      AS public_execute,
         pg_catalog.has_function_privilege(current_user, p.oid, 'EXECUTE')  AS runtime_execute
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles     o ON o.oid = p.proowner
    JOIN pg_catalog.pg_type      t ON t.oid = p.prorettype
   WHERE n.nspname = 'worker_resolvers'
   ORDER BY p.proname
`;

const SQL_WORKER_SCHEMA_PRIVS = `
  SELECT pg_catalog.has_schema_privilege('public', 'worker_resolvers', 'USAGE')       AS public_usage,
         pg_catalog.has_schema_privilege('public', 'worker_resolvers', 'CREATE')      AS public_create,
         pg_catalog.has_schema_privilege(current_user, 'worker_resolvers', 'USAGE')   AS runtime_usage
`;

const SQL_AUTH_SCHEMA = `
  SELECT n.nspname AS schema_name,
         o.rolname AS owner
    FROM pg_catalog.pg_namespace n
    JOIN pg_catalog.pg_roles     o ON o.oid = n.nspowner
   WHERE n.nspname = 'auth_resolvers'
`;

const SQL_AUTH_FUNCTION_SUMMARY = `
  SELECT count(*)::int                                  AS function_count,
         count(*) FILTER (WHERE p.prosecdef)::int       AS security_definer_count,
         count(DISTINCT o.rolname)::int                 AS distinct_owner_count,
         min(o.rolname)                                 AS owner_name
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles     o ON o.oid = p.proowner
   WHERE n.nspname = 'auth_resolvers'
`;

const SQL_PRIVILEGE_SUMMARY = `
  SELECT
    pg_catalog.has_table_privilege(current_user, 'public.channel_sync_queue_store', 'SELECT') AS runtime_queue_select,
    pg_catalog.has_table_privilege(current_user, 'public.scheduled_jobs', 'SELECT')           AS runtime_jobs_select,
    (SELECT count(*)::int FROM information_schema.column_privileges
      WHERE table_schema = 'public'
        AND table_name   = 'channel_sync_queue_store'
        AND grantee      = 'qyrvia_auth_resolver')  AS resolver_queue_column_grants,
    (SELECT count(*)::int FROM information_schema.column_privileges
      WHERE table_schema = 'public'
        AND table_name   = 'scheduled_jobs'
        AND grantee      = 'qyrvia_auth_resolver')  AS resolver_jobs_column_grants,
    (SELECT count(*)::int FROM information_schema.table_privileges
      WHERE table_schema = 'public'
        AND table_name IN ('channel_sync_queue_store', 'scheduled_jobs')
        AND grantee      = 'qyrvia_auth_resolver')  AS resolver_table_grants,
    (SELECT count(*)::int FROM information_schema.routine_privileges
      WHERE specific_schema = 'worker_resolvers')   AS worker_routine_grants
`;

/* ===========================================================================
 * 3. HELPERS
 * ========================================================================= */

function volatilityName(code) {
  if (code === 'i') return 'IMMUTABLE';
  if (code === 's') return 'STABLE';
  if (code === 'v') return 'VOLATILE';
  return 'UNKNOWN';
}

function roleView(rows, name) {
  const r = rows.find((x) => x.role_name === name);
  if (!r) return { role_name: name, exists: false, can_login: null, is_superuser: null, bypassrls: null };
  return {
    role_name:    name,
    exists:       true,
    can_login:    r.can_login === true,
    is_superuser: r.is_superuser === true,
    bypassrls:    r.bypassrls === true,
  };
}

function tableView(rows, name) {
  const r = rows.find((x) => x.table_name === name);
  if (!r) return { schema: 'public', table: name, exists: false, owner: null, rls_enabled: null, force_rls: null };
  return {
    schema:      r.schema_name,
    table:       r.table_name,
    exists:      true,
    owner:       r.owner,
    rls_enabled: r.rls_enabled === true,
    force_rls:   r.force_rls === true,
  };
}

/* ===========================================================================
 * 4. METADATA COLLECTION — read-only transaction already open and verified
 * ========================================================================= */

async function collect(client, identity, connectedRole) {
  const expectedRolesRows = (await client.query(SQL_EXPECTED_ROLES)).rows;
  const membershipRows    = (await client.query(SQL_ROLE_MEMBERSHIPS)).rows;
  const sourceTableRows   = (await client.query(SQL_SOURCE_TABLES)).rows;
  const workerSchemaRows  = (await client.query(SQL_WORKER_SCHEMA)).rows;
  const workerObjectRows  = (await client.query(SQL_WORKER_OBJECT_COUNT)).rows;
  const workerFuncRows    = (await client.query(SQL_WORKER_FUNCTIONS)).rows;
  const authSchemaRows    = (await client.query(SQL_AUTH_SCHEMA)).rows;
  const authSummaryRows   = (await client.query(SQL_AUTH_FUNCTION_SUMMARY)).rows;
  const privSummaryRows   = (await client.query(SQL_PRIVILEGE_SUMMARY)).rows;

  const workerExists = workerSchemaRows.length > 0;

  // has_schema_privilege() raises when the schema is absent, so it is only
  // asked when the schema is known to exist.
  let workerSchemaPrivs = { public_usage: null, public_create: null, runtime_usage: null };
  if (workerExists) {
    const r = (await client.query(SQL_WORKER_SCHEMA_PRIVS)).rows[0] || {};
    workerSchemaPrivs = {
      public_usage:  r.public_usage === true,
      public_create: r.public_create === true,
      runtime_usage: r.runtime_usage === true,
    };
  }

  const runtimeName = identity.current_user_name;
  const inResolver    = membershipRows.some((m) => m.granted_role === RESOLVER_ROLE     && (m.member_role === RUNTIME_ROLE || m.member_role === runtimeName));
  const inSchemaOwner = membershipRows.some((m) => m.granted_role === SCHEMA_OWNER_ROLE && (m.member_role === RUNTIME_ROLE || m.member_role === runtimeName));

  const auth = authSummaryRows[0] || {};
  const priv = privSummaryRows[0] || {};

  return {
    probe_version: PROBE_VERSION,

    target: {
      host:     ALLOWED_HOST,
      port:     ALLOWED_PORT,
      database: ALLOWED_DB,
    },

    connected_identity: {
      database:              identity.database_name,
      current_user:          identity.current_user_name,
      session_user:          identity.session_user_name,
      is_superuser:          connectedRole.is_superuser === true,
      bypassrls:             connectedRole.bypassrls === true,
      transaction_read_only: true,
    },

    expected_roles: [
      roleView(expectedRolesRows, RUNTIME_ROLE),
      roleView(expectedRolesRows, RESOLVER_ROLE),
      roleView(expectedRolesRows, SCHEMA_OWNER_ROLE),
    ],

    role_memberships: {
      runtime_in_auth_resolver:     inResolver,
      runtime_in_auth_schema_owner: inSchemaOwner,
      total_membership_count:       membershipRows.length,
    },

    source_tables: [
      tableView(sourceTableRows, 'channel_sync_queue_store'),
      tableView(sourceTableRows, 'scheduled_jobs'),
    ],

    worker_resolvers: {
      exists:              workerExists,
      owner:               workerExists ? workerSchemaRows[0].owner : null,
      object_count:        (workerObjectRows[0] && workerObjectRows[0].object_count) || 0,
      function_count:      workerFuncRows.length,
      functions:           workerFuncRows.map((f) => ({
        function_name:     f.function_name,
        owner:             f.owner,
        security_definer:  f.security_definer === true,
        volatility:        volatilityName(f.volatility_code),
        return_type:       f.return_type,
        fixed_search_path: f.fixed_search_path === true,
        public_execute:    f.public_execute === true,
        runtime_execute:   f.runtime_execute === true,
      })),
      public_schema_usage:  workerSchemaPrivs.public_usage,
      public_schema_create: workerSchemaPrivs.public_create,
      runtime_schema_usage: workerSchemaPrivs.runtime_usage,
    },

    auth_resolvers: {
      exists:                 authSchemaRows.length > 0,
      owner:                  authSchemaRows.length > 0 ? authSchemaRows[0].owner : null,
      function_count:         auth.function_count || 0,
      security_definer_count: auth.security_definer_count || 0,
      distinct_owner_count:   auth.distinct_owner_count || 0,
      function_owner:         auth.owner_name || null,
    },

    privilege_summary: {
      runtime_queue_table_select:   priv.runtime_queue_select === true,
      runtime_jobs_table_select:    priv.runtime_jobs_select === true,
      resolver_queue_column_grants: priv.resolver_queue_column_grants || 0,
      resolver_jobs_column_grants:  priv.resolver_jobs_column_grants || 0,
      resolver_table_grants:        priv.resolver_table_grants || 0,
      worker_routine_grants:        priv.worker_routine_grants || 0,
    },

    verdict: 'PRE_BOOTSTRAP_STATE_INVALID',
  };
}

/* ===========================================================================
 * 5. PRE-BOOTSTRAP CONTRACT — every clause of Phase 66A-B2A §8
 * ========================================================================= */

function evaluate(result) {
  const ci  = result.connected_identity;
  const rt  = result.expected_roles.find((r) => r.role_name === RUNTIME_ROLE);
  const rr  = result.expected_roles.find((r) => r.role_name === RESOLVER_ROLE);
  const so  = result.expected_roles.find((r) => r.role_name === SCHEMA_OWNER_ROLE);
  const q   = result.source_tables.find((t) => t.table === 'channel_sync_queue_store');
  const j   = result.source_tables.find((t) => t.table === 'scheduled_jobs');
  const wr  = result.worker_resolvers;

  const ok =
    // connection
    ci.database === ALLOWED_DB &&
    ci.transaction_read_only === true &&
    // the connected role itself must be unprivileged
    ci.is_superuser === false &&
    ci.bypassrls === false &&
    // the named runtime role must also be unprivileged
    rt && rt.exists && rt.is_superuser === false && rt.bypassrls === false &&
    // definer role: exists, cannot log in, not superuser, holds BYPASSRLS
    rr && rr.exists && rr.can_login === false && rr.is_superuser === false && rr.bypassrls === true &&
    // schema owner: exists, cannot log in, not superuser, no BYPASSRLS
    so && so.exists && so.can_login === false && so.is_superuser === false && so.bypassrls === false &&
    // no privileged membership
    result.role_memberships.runtime_in_auth_resolver === false &&
    result.role_memberships.runtime_in_auth_schema_owner === false &&
    // both source tables locked down
    q && q.exists && q.rls_enabled === true && q.force_rls === true &&
    j && j.exists && j.rls_enabled === true && j.force_rls === true &&
    // nothing installed yet
    wr.exists === false &&
    wr.function_count === 0;

  result.verdict = ok ? 'PRE_BOOTSTRAP_STATE_VALID' : 'PRE_BOOTSTRAP_STATE_INVALID';
  return ok;
}

/* ===========================================================================
 * 6. MAIN — guarded acquisition, verified read-only, guaranteed cleanup
 * ========================================================================= */

async function main() {
  // Guard first. If this throws, `pg` is never loaded and no socket is opened.
  const connectionString = resolveTarget();

  // Only now is the driver introduced.
  const { Pool } = require('pg');

  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 1000,
    allowExitOnIdle: true,
  });

  let client = null;
  let txOpen = false;
  let result = null;

  try {
    try {
      client = await pool.connect();
    } catch (e) {
      throw new ProbeError(CAT.CONNECT, CAT.CONNECT, safePgCode(e));
    }

    // ---- read-only transaction, opened before ANY metadata query ----------
    try {
      await client.query(SQL_BEGIN_READ_ONLY);
      txOpen = true;
    } catch (e) {
      throw new ProbeError(CAT.READ_ONLY, ERR.READ_ONLY, safePgCode(e));
    }

    // ---- prove the session really is read-only ----------------------------
    let readOnly;
    try {
      readOnly = (await client.query(SQL_SHOW_READ_ONLY)).rows[0];
    } catch (e) {
      throw new ProbeError(CAT.READ_ONLY, ERR.READ_ONLY, safePgCode(e));
    }
    if (!readOnly || readOnly.transaction_read_only !== 'on') {
      throw new ProbeError(CAT.READ_ONLY, ERR.READ_ONLY, null);
    }

    // ---- confirm the SERVER is the target we demanded ---------------------
    let identity;
    let connectedRole;
    try {
      identity      = (await client.query(SQL_IDENTITY)).rows[0];
      connectedRole = (await client.query(SQL_CONNECTED_ROLE)).rows[0] || {};
    } catch (e) {
      throw new ProbeError(CAT.METADATA, CAT.METADATA, safePgCode(e));
    }
    if (!identity || identity.database_name !== ALLOWED_DB) {
      throw new ProbeError(CAT.CONNECT, ERR.CONN_DB, null);
    }
    if (identity.server_host !== ALLOWED_HOST) {
      throw new ProbeError(CAT.CONNECT, ERR.CONN_HOST, null);
    }
    if (Number(identity.server_port) !== ALLOWED_PORT) {
      throw new ProbeError(CAT.CONNECT, ERR.CONN_PORT, null);
    }

    // ---- catalog reads ----------------------------------------------------
    try {
      result = await collect(client, identity, connectedRole);
    } catch (e) {
      throw new ProbeError(CAT.METADATA, CAT.METADATA, safePgCode(e));
    }
  } finally {
    // Cleanup can never be skipped, and can never mask the original failure.
    if (client) {
      if (txOpen) {
        try { await client.query(SQL_ROLLBACK); }
        catch (_) { process.stderr.write(CAT.CLEANUP + '\n'); }
      }
      try { client.release(); }
      catch (_) { process.stderr.write(CAT.CLEANUP + '\n'); }
    }
    try { await pool.end(); }
    catch (_) { process.stderr.write(CAT.CLEANUP + '\n'); }
  }

  const valid = evaluate(result);
  console.log(JSON.stringify(result));
  return valid;
}

/* ---------------------------------------------------------------------------
 * Entry point. Runs ONLY when a human invokes this file directly — importing
 * it does nothing. There is no retry, no fallback target and no second
 * connection attempt anywhere in this file.
 * ------------------------------------------------------------------------- */
if (require.main === module) {
  main()
    .then((valid) => {
      if (!valid) {
        process.stderr.write(CAT.INVALID + '\n');
        process.exitCode = 1;
      }
    })
    .catch((e) => {
      const category = (e && e.category) || CAT.CONFIG;
      const code     = (e && e.code) || 'UNKNOWN';
      const pgCode   = (e && e.pgCode) || null;
      const detail   = (code === category) ? '' : ' ' + code;
      process.stderr.write(category + detail + (pgCode ? ' pg_code=' + pgCode : '') + '\n');
      process.exitCode = 1;
    });
}
