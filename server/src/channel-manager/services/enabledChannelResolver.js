'use strict';

/**
 * Phase 66A C5 — the production enabled-channel resolver.
 *
 * WHAT IT IS FOR
 * ──────────────
 * Phase 65 gave the event spine per-OTA fan-out but nothing to fan out TO: with
 * no resolver wired, `fanOutAndEnqueue` correctly refused to guess and enqueued
 * nothing. This is the missing half — the thing that answers "which channels is
 * this property actually selling on right now?".
 *
 * WHY IT DOES NOT GO THROUGH channelRegistryService
 * ─────────────────────────────────────────────────
 * Two concrete reasons, both of which would be bugs:
 *
 *  1. `channelRegistryService.list()` calls `_ensureSeeded()`, which WRITES the
 *     eight default rows when it sees an empty result. Calling that from an
 *     event handler makes a read path write, and inside a READ ONLY transaction
 *     it would simply fail. Resolving must never mutate.
 *
 *  2. `channelRegistryRepo.db` issues bare `db.query(...)` on the shared pool.
 *     `channel_registry` is ENABLE + FORCE ROW LEVEL SECURITY with a policy on
 *     `app.tenant_id` (0055_channel_registry.sql), so on a pooled connection
 *     with no tenant bound it returns ZERO ROWS — and zero enabled channels is
 *     indistinguishable from "this property sells nowhere". The fan-out would
 *     silently stop, exactly the class of defect Phase 64 existed to remove.
 *
 * So the resolver runs its own tenant-bound READ ONLY unit of work and issues a
 * single explicit SELECT.
 *
 * FAIL CLOSED
 * ───────────
 * Any failure — missing tenant, unreadable registry, unrecognised code — THROWS.
 * `channelSubscriber.fanOutAndEnqueue` converts that into
 * `channel_registry_unavailable` and enqueues nothing. A registry we cannot read
 * is not permission to broadcast a guest's reservation to every OTA we know of.
 */

const { canonicalChannelCode } = require('./channelEventRouter');

const SQL = `
  SELECT channel_code, enabled, status
    FROM channel_registry
   WHERE tenant_id = $1
     AND (property_id = $2 OR ($2::uuid IS NULL AND property_id IS NULL))
     AND enabled = true`;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * @param {object}   deps
 * @param {object}   deps.pool                 pg pool (or instrumented wrapper)
 * @param {Function} deps.runWithTenantRead    from src/db/tenantUnitOfWork
 * @returns {(ctx:{tenantId:string, propertyId:string, eventType?:string}) => Promise<string[]>}
 */
function buildEnabledChannelResolver({ pool, runWithTenantRead }) {
  if (!pool) throw new Error('buildEnabledChannelResolver: pool is required');
  if (typeof runWithTenantRead !== 'function') {
    throw new Error('buildEnabledChannelResolver: runWithTenantRead is required');
  }

  return async function resolveChannels({ tenantId, propertyId } = {}) {
    // The caller passes the TRUSTED envelope values. A missing tenant is a
    // programming error upstream, not something to paper over with a default.
    if (!tenantId) {
      throw fail('channel_registry_unavailable',
        'resolveChannels: tenantId is required (must come from the domain-event envelope)');
    }

    const rows = await runWithTenantRead(pool, tenantId, async (client) => {
      const r = await client.query(SQL, [tenantId, propertyId || null]);
      return (r && r.rows) || [];
    });

    const out = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row || row.enabled !== true) continue;          // belt and braces
      // A historical row may still read QTCN (0056 renamed most of them, but a
      // row created before that migration on a restored database can survive).
      // Canonicalise on READ; nothing is ever written back with a legacy code.
      const code = canonicalChannelCode(row.channel_code);
      if (!code) {
        throw fail('channel_identity_invalid',
          'resolveChannels: registry holds a non-canonical channel code');
      }
      if (seen.has(code)) continue;
      seen.add(code);
      out.push(code);
    }
    // An empty result is a legitimate answer — this property sells on no
    // channel — and is NOT the same as "return everything we know about".
    return out;
  };
}

module.exports = { buildEnabledChannelResolver, RESOLVER_SQL: SQL };
