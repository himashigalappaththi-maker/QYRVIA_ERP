'use strict';

/**
 * Phase 64 — tenant-bound unit of work.
 *
 * WHY THIS EXISTS (P0-11)
 * ───────────────────────
 * Every PMS table carries `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL
 * SECURITY` with a policy keyed on `app.tenant_id` (reservations 0019, folios
 * and housekeeping 0023, night-audit runs 0025, payment allocations 0037,
 * properties 0004, and the SARGable rewrite in 0051 which routes them all
 * through `public.app_current_tenant()`).
 *
 * The repositories, however, issued bare `pool.query(...)`. A pooled connection
 * carries no `app.tenant_id`, so under the non-superuser / NOBYPASSRLS role this
 * project's own guard mandates (`server/test/db/_rlsGuard.js`), every PMS SELECT
 * returned zero rows and every INSERT failed its policy WITH CHECK. The whole
 * reservation → check-in → folio → payment → night-audit → check-out chain was
 * therefore non-functional against a correctly provisioned database — and if it
 * appeared to work anywhere, the runtime role held superuser or BYPASSRLS, which
 * means tenant isolation was not being enforced at all.
 *
 * The same gap made every multi-statement PMS command non-atomic (P1-5, P1-6,
 * P1-8): with each statement on its own pooled connection there was no
 * transaction to roll back.
 *
 * THE DESIGN
 * ──────────
 * One explicit unit of work per command or query. It:
 *   1. takes exactly ONE client out of the pool,
 *   2. opens a transaction,
 *   3. binds `app.tenant_id` with transaction-LOCAL scope,
 *   4. PROVES the bind took by asking the database what it thinks the tenant is,
 *   5. publishes that client through AsyncLocalStorage so repository methods can
 *      reach it without every call site threading it manually,
 *   6. commits, or rolls back the WHOLE unit on any failure.
 *
 * `set_config(..., is_local => true)` is used rather than `SET` so the binding
 * dies with the transaction and can never leak to the next borrower of that
 * pooled connection.
 *
 * FAIL CLOSED, ALWAYS
 * ───────────────────
 * There is deliberately NO fallback to `pool.query`. A tenant-scoped query
 * outside a unit of work throws `TENANT_CONTEXT_REQUIRED`. That is the entire
 * point: a silent fallback is what produced P0-11 in the first place, and a
 * query that quietly runs without RLS context is either invisible data loss or a
 * cross-tenant leak, depending on the role it runs as.
 *
 * The tenant id is never inferred from request input, SQL parameters, or mutable
 * module state — only from the value the caller explicitly bound when opening
 * the unit of work.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const ERR = {
  TENANT_CONTEXT_REQUIRED: 'TENANT_CONTEXT_REQUIRED',
  TENANT_CONTEXT_MISMATCH: 'TENANT_CONTEXT_MISMATCH',
  TENANT_ID_INVALID:       'TENANT_ID_INVALID',
  TENANT_BIND_FAILED:      'TENANT_BIND_FAILED',
  TENANT_READ_ONLY:        'TENANT_READ_ONLY_CONTEXT',
  TENANT_ROLLBACK_FAILED:  'TENANT_ROLLBACK_FAILED'
};

function fail(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function assertUuid(tenantId) {
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
    throw fail(ERR.TENANT_ID_INVALID,
      'tenantUnitOfWork: tenantId must be a UUID string');
  }
}

// ---------------------------------------------------------------------------
// Context accessors
// ---------------------------------------------------------------------------

/** The active unit of work, or null. Never throws — use for branching. */
function getContext() {
  return storage.getStore() || null;
}

/** True when a tenant-bound client is currently active. */
function hasTenantContext() {
  return Boolean(storage.getStore());
}

/** The bound tenant id, or null when no unit of work is active. */
function getTenantId() {
  const ctx = storage.getStore();
  return ctx ? ctx.tenantId : null;
}

/**
 * The active unit of work. Throws TENANT_CONTEXT_REQUIRED when there is none.
 * `label` names the caller so the failure says which operation was unscoped.
 */
function requireTenantContext(label) {
  const ctx = storage.getStore();
  if (!ctx) {
    throw fail(ERR.TENANT_CONTEXT_REQUIRED,
      (label ? label + ': ' : '') +
      'no tenant-bound unit of work is active. A tenant-scoped query must run ' +
      'inside runWithTenantTransaction() or runWithTenantRead() — there is no ' +
      'pool fallback by design.');
  }
  return ctx;
}

/**
 * The tenant-bound client. Throws TENANT_CONTEXT_REQUIRED outside a unit of
 * work. This is the ONLY sanctioned way for a tenant-scoped repository method
 * to obtain a connection.
 */
function getTenantClient(label) {
  return requireTenantContext(label || 'getTenantClient').client;
}

/**
 * Run a query on the active tenant-bound client.
 * Never falls back to the pool. Never infers a tenant from `params`.
 */
function tenantQuery(text, params) {
  const ctx = requireTenantContext('tenantQuery');
  return ctx.client.query(text, params);
}

// ---------------------------------------------------------------------------
// Unit-of-work entry points
// ---------------------------------------------------------------------------

/**
 * Bind the tenant on an already-open transaction and prove the bind took.
 * `set_config(..., true)` is transaction-LOCAL: it cannot survive into the next
 * user of this pooled connection.
 */
async function bindTenant(client, tenantId) {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

  // Proof, not assumption. If app_current_tenant() disagrees, the policies will
  // not see what we think they will, and continuing would mean writing rows
  // under the wrong tenant or silently reading none.
  const res = await client.query('SELECT public.app_current_tenant()::text AS tid');
  const bound = res && res.rows && res.rows[0] ? res.rows[0].tid : null;
  if (String(bound || '').toLowerCase() !== String(tenantId).toLowerCase()) {
    throw fail(ERR.TENANT_BIND_FAILED,
      'tenantUnitOfWork: app.tenant_id did not bind (database reports ' +
      (bound === null ? 'NULL' : 'a different tenant') + ')');
  }
}

/**
 * Decide what a nested call should do. Reuse is the only correct answer for the
 * same tenant: opening a second transaction on a second connection would break
 * atomicity in exactly the way this phase exists to fix.
 */
function resolveNested(ctx, tenantId, wantMode) {
  if (ctx.tenantId.toLowerCase() !== String(tenantId).toLowerCase()) {
    throw fail(ERR.TENANT_CONTEXT_MISMATCH,
      'tenantUnitOfWork: a unit of work for a different tenant is already active. ' +
      'Cross-tenant work must not share a transaction.');
  }
  if (wantMode === 'write' && ctx.mode === 'read') {
    throw fail(ERR.TENANT_READ_ONLY,
      'tenantUnitOfWork: cannot perform write work inside a READ ONLY unit of work.');
  }
  return ctx;
}

/**
 * Roll back and release. A client whose ROLLBACK failed is NOT returned to the
 * pool — it may still be inside an aborted transaction, and handing it to the
 * next caller would poison an unrelated request.
 */
async function rollbackAndRelease(client, originalError) {
  let rollbackError = null;
  try {
    await client.query('ROLLBACK');
  } catch (err) {
    rollbackError = err;
  }

  try {
    // release(true) destroys the connection instead of recycling it.
    client.release(Boolean(rollbackError));
  } catch (_) { /* the pool is already unhappy; the throw below is what matters */ }

  if (rollbackError) {
    // Never silently continue after a failed rollback. Surface the original
    // failure (it is the actionable one) but carry the rollback failure with it
    // so it cannot be lost.
    if (originalError) {
      originalError.rollbackFailed = true;
      originalError.rollbackError = String(rollbackError.message || rollbackError);
      throw originalError;
    }
    throw fail(ERR.TENANT_ROLLBACK_FAILED,
      'tenantUnitOfWork: ROLLBACK failed: ' + String(rollbackError.message || rollbackError));
  }

  if (originalError) throw originalError;
}

async function runUnit(pool, tenantId, callback, mode) {
  assertUuid(tenantId);
  if (typeof callback !== 'function') {
    throw new Error('tenantUnitOfWork: callback must be a function');
  }

  // Nested: reuse the open transaction and its client. Never acquire a second.
  const existing = storage.getStore();
  if (existing) {
    const ctx = resolveNested(existing, tenantId, mode);
    return callback(ctx.client, ctx);
  }

  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('tenantUnitOfWork: a pool with connect() is required');
  }

  const client = await pool.connect();
  let started = false;
  try {
    await client.query(mode === 'read' ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN');
    started = true;
    await bindTenant(client, tenantId);

    const ctx = Object.freeze({ tenantId, client, mode });
    const result = await storage.run(ctx, () => callback(client, ctx));

    // A READ ONLY transaction has nothing to durably commit, but COMMIT is the
    // clean way to end it and returns the connection in a known state.
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (err) {
    if (!started) {
      try { client.release(true); } catch (_) { /* nothing useful left to do */ }
      throw err;
    }
    await rollbackAndRelease(client, err);
    /* rollbackAndRelease always throws when given an error */
    throw err;
  }
}

/**
 * Open a tenant-bound READ/WRITE unit of work.
 * The callback receives (client, ctx) and may also reach the client through
 * getTenantClient() / tenantQuery() anywhere in its async call tree.
 * Commits on success; rolls the ENTIRE unit back on any throw.
 */
function runWithTenantTransaction(pool, tenantId, callback) {
  return runUnit(pool, tenantId, callback, 'write');
}

/**
 * Open a tenant-bound READ ONLY unit of work. PostgreSQL itself rejects writes
 * inside it, so a query handler cannot mutate state by accident.
 */
function runWithTenantRead(pool, tenantId, callback) {
  return runUnit(pool, tenantId, callback, 'read');
}

module.exports = {
  runWithTenantTransaction,
  runWithTenantRead,
  getTenantClient,
  getTenantId,
  getContext,
  hasTenantContext,
  requireTenantContext,
  tenantQuery,
  ERR,
  UUID_RE
};
