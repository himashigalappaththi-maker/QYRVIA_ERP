'use strict';

/**
 * Phase 66A-B2N-D — ARI outbox tenant discovery.
 *
 * ari_outbox_store is ENABLE + FORCE ROW LEVEL SECURITY, keyed on
 * app.tenant_id. A global drain worker therefore cannot ask "which tenants have
 * work?" directly: with no tenant bound it sees zero rows, and zero rows is
 * indistinguishable from "nothing to do". Reading tenants.code to find out is
 * circular — that column is itself behind the same FORCE RLS.
 *
 * The ONLY sanctioned answer in this repository is the committed SECURITY
 * DEFINER resolver owned by qyrvia_auth_resolver (NOLOGIN + BYPASSRLS),
 * installed by a superuser bootstrap and granted EXECUTE to the application
 * role. This module is a thin, defensive client for exactly one of those
 * functions and nothing else.
 *
 * WHAT THIS MODULE MUST NEVER DO — and does not:
 *   - query public.tenants, or any tenant-code lookup;
 *   - query public.ari_outbox_store directly (that is the tenant-bound
 *     wrappers' job, inside a proven tenant transaction);
 *   - SET ROLE, SET app.tenant_id, or otherwise bypass or relax RLS;
 *   - execute a bootstrap, or create/alter any database object;
 *   - log a credential, a connection string or any environment value.
 *
 * The function returns ONE fact per tenant — "there is actionable ARI outbox
 * work here" — as a bare uuid. No outbox id, property, dedupe key or payload
 * ever crosses this boundary, so a compromised worker learns nothing about
 * another tenant beyond that a tenant exists and has work.
 */

/** The one resolver this module is permitted to call. */
const RESOLVER_FN = 'worker_resolvers.due_ari_outbox_tenants';

/** Mirrors the resolver's own 1..1000 guard, so a bad limit fails here first. */
const MIN_LIMIT = 1;
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message) {
  return new Error('ariOutboxTenantResolver: ' + message);
}

/**
 * @param {object} deps
 * @param {{query: Function}} deps.pool  the ordinary application pool — used
 *        for this ONE function call and nothing else.
 */
function buildAriOutboxTenantResolver({ pool } = {}) {
  if (!pool || typeof pool.query !== 'function') throw fail('pool.query required');

  return {
    /**
     * @returns {Promise<string[]>} distinct, validated tenant UUIDs, capped.
     *
     * Fails CLOSED on malformed resolver output. A resolver that returns a
     * non-uuid is either misinstalled or compromised; treating the row as
     * "probably fine" would hand an unvalidated identifier straight into a
     * tenant-bound transaction, so this throws instead of filtering silently.
     */
    async resolveDueTenants({ limit = DEFAULT_LIMIT } = {}) {
      if (!Number.isInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
        throw fail('limit must be an integer in [' + MIN_LIMIT + ', ' + MAX_LIMIT + ']');
      }

      const r = await pool.query('SELECT tenant_id FROM ' + RESOLVER_FN + '($1)', [limit]);
      const rows = (r && r.rows) || [];

      const seen = new Set();
      const out = [];
      for (const row of rows) {
        const id = row && row.tenant_id;
        if (typeof id !== 'string' || !UUID_RE.test(id)) {
          // Deliberately does NOT echo the offending value: it came from a
          // privileged definer context and may carry cross-tenant meaning.
          throw fail('resolver returned a non-UUID tenant identifier');
        }
        // Defensive dedupe. The SQL already says SELECT DISTINCT, but this
        // module must not depend on a remote guarantee it cannot enforce:
        // a duplicate here would drive two concurrent units of work for the
        // same tenant in one tick.
        const key = id.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(id);
      }

      // The resolver's own LIMIT should make this unreachable; keeping it means
      // a future resolver edit cannot quietly widen the worker's per-tick fan-out.
      if (out.length > limit) throw fail('resolver returned more tenants than the requested limit');

      return out;
    }
  };
}

module.exports = {
  buildAriOutboxTenantResolver,
  RESOLVER_FN,
  MIN_LIMIT,
  MAX_LIMIT,
  DEFAULT_LIMIT
};
