'use strict';

/**
 * Phase 66A-B2N-A — tenant-bound unit-of-work factory for the ARI store.
 *
 * buildDbAriStore({db}) (./dbStore.js) already accepts any generic
 * {query(text,params)} object — it was never hardcoded to a bare Pool. The
 * P0-11-class gap this phase closes was entirely at the CALL site: src/
 * index.js constructed exactly one buildDbAriStore({db: obsPool}) instance
 * at boot and reused it everywhere, so every ARI write ran on a bare pool
 * connection with no app.tenant_id bound, against tables that are all
 * ENABLE + FORCE ROW LEVEL SECURITY (migration 0049_ari_foundation.sql).
 *
 * This file builds a FRESH ARI store per call, bound to a transaction-local,
 * tenant-bound client obtained from server/src/db/tenantUnitOfWork.js —
 * exactly the same pattern server/src/channel-manager/persistence/dbStores.js
 * already established for the channel queue's claim/complete/retry/
 * dead-letter paths (dequeuePendingAcrossTenants, markQueueCompletedForTenant,
 * etc: build the store fresh, once, per tenant-bound client).
 *
 * runWithTenantTransaction/runWithTenantRead already provide "join if a unit
 * of work for this tenant is already open, else open a fresh one" for free
 * (see tenantUnitOfWork.js's runUnit(): a nested call for the SAME tenantId
 * reuses the existing AsyncLocalStorage-published client and never acquires
 * a second pool connection) — so callers do not need to know or care whether
 * they are joining an existing transaction or starting one; they only need
 * to pass the same pool and the same trusted tenantId.
 *
 * No SQL, no schema, and no new transaction primitive is introduced here —
 * this module only composes two already-approved building blocks.
 */

const { runWithTenantTransaction, runWithTenantRead } = require('../../db/tenantUnitOfWork');
const { buildDbAriStore } = require('./dbStore');
const { buildAriOutboxStore } = require('../outbox/ariOutboxStore');

/**
 * Phase 66A-B2N-C1 — the permanent half-open sentinel window for UNDATED ARI
 * configuration events (room types and rate plans are configuration, not
 * date-scoped, but ari_outbox_store requires effective_from/effective_to NOT
 * NULL with CHECK (effective_to > effective_from)).
 *
 * These are fixed constants, never computed: they participate in the
 * canonical dedupe key, so a value that drifted would silently re-key every
 * configuration event ever emitted. Defined once here and reused everywhere.
 */
const ARI_CONFIG_EFFECTIVE_FROM = '1970-01-01';
const ARI_CONFIG_EFFECTIVE_TO   = '9999-12-31';

/**
 * Phase 66A-B2N-C1 — ONE tenant-bound unit of work exposing BOTH the
 * authoritative ARI store and the ARI outbox, built from the SAME
 * transaction-local client. This is what makes an authoritative mutation and
 * its outbox event atomic: they are two statements on one client inside one
 * transaction, so they commit together or roll back together.
 *
 * runWithTenantTransaction is called exactly once. It already provides
 * "join an open same-tenant unit, else open a fresh one" (never a second
 * connection, never a nested independent transaction), rejects cross-tenant
 * nesting with TENANT_CONTEXT_MISMATCH, and owns COMMIT/ROLLBACK entirely —
 * nothing here commits, rolls back, binds a tenant or falls back to the bare
 * pool.
 */
function withTenantAriUnit(pool, tenantId, callback) {
  return runWithTenantTransaction(pool, tenantId, (client) =>
    callback({
      ariStore: buildDbAriStore({ db: client }),
      outbox:   buildAriOutboxStore({ db: client })
    })
  );
}

/**
 * Open (or join) one tenant-bound WRITE transaction and hand the callback an
 * ARI store bound to that transaction's client. Commits on success, rolls
 * back the whole unit on any thrown error — never a partial multi-statement
 * commit.
 *
 * B2N-C1: the store handed to the callback additionally carries `.outbox` —
 * the ARI outbox bound to the very same client — so an emitting caller that
 * only ever receives this opaque store (e.g. booking-engine/
 * ariInventoryAdjuster.js, which must not require from ari/) can enqueue
 * inside the same transaction without any new wiring.
 */
function withTenantAriStore(pool, tenantId, callback) {
  return withTenantAriUnit(pool, tenantId, ({ ariStore, outbox }) => {
    ariStore.outbox = outbox;
    return callback(ariStore);
  });
}

/**
 * Open (or join) one tenant-bound READ ONLY unit of work and hand the
 * callback an ARI store bound to that transaction's client. PostgreSQL
 * itself rejects any write attempted through this path.
 */
function withTenantAriRead(pool, tenantId, callback) {
  return runWithTenantRead(pool, tenantId, (client) =>
    callback(buildDbAriStore({ db: client }))
  );
}

module.exports = {
  withTenantAriUnit,
  withTenantAriStore,
  withTenantAriRead,
  ARI_CONFIG_EFFECTIVE_FROM,
  ARI_CONFIG_EFFECTIVE_TO
};
