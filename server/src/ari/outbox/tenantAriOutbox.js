'use strict';

/**
 * Phase 66A-B2N-B — tenant-bound ARI outbox access, mirroring
 * src/ari/store/tenantAriStore.js (B2N-A) exactly.
 *
 * withTenantAriOutbox(pool, tenantId, callback) opens (or joins) ONE
 * tenant-bound READ/WRITE unit of work via the approved
 * src/db/tenantUnitOfWork.js helper and hands the callback an
 * ariOutboxStore bound to that transaction's client. Because
 * runWithTenantTransaction reuses an already-open same-tenant unit of work
 * (AsyncLocalStorage join — never a second connection or BEGIN) and fails
 * closed on a cross-tenant nested call, this is what lets a B2N-C ARI
 * mutation and its outbox enqueue share the EXACT same transaction-bound
 * client:
 *
 *   withTenantAriStore(pool, tenantId, async (ariStore) => {
 *     await ariStore.adjustSold(...);                      // same client
 *     await withTenantAriOutbox(pool, tenantId, (outbox) => // joins, no
 *       outbox.enqueue(...));                              // second txn
 *   });
 *
 * There is NO bare-pool fallback (the table is FORCE RLS; tenantUnitOfWork
 * throws TENANT_CONTEXT_REQUIRED/TENANT_ID_INVALID before any SQL), and no
 * manual SET SESSION anywhere — tenant binding is transaction-local and
 * lives solely inside tenantUnitOfWork.js.
 *
 * The convenience per-operation wrappers below mirror dbStores.js's
 * markQueue*ForTenant shape (B2J/B2M): one fresh, single-purpose tenant
 * unit of work around the original store method.
 */

const { runWithTenantTransaction } = require('../../db/tenantUnitOfWork');
const { buildAriOutboxStore } = require('./ariOutboxStore');

function withTenantAriOutbox(pool, tenantId, callback) {
  return runWithTenantTransaction(pool, tenantId, (client) =>
    callback(buildAriOutboxStore({ db: client }))
  );
}

function enqueueForTenant({ pool, tenantId, event }) {
  return withTenantAriOutbox(pool, tenantId, (outbox) =>
    outbox.enqueue(Object.assign({}, event, { tenantId }))
  );
}

function claimDueForTenant({ pool, tenantId, limit, leaseOwner, leaseMs }) {
  return withTenantAriOutbox(pool, tenantId, (outbox) =>
    outbox.claimDue({ limit, leaseOwner, leaseMs })
  );
}

function markCompletedForTenant({ pool, tenantId, id }) {
  return withTenantAriOutbox(pool, tenantId, (outbox) => outbox.markCompleted(id));
}

function markRetryScheduledForTenant({ pool, tenantId, id, nextRetryAt }) {
  return withTenantAriOutbox(pool, tenantId, (outbox) =>
    outbox.markRetryScheduled(id, nextRetryAt)
  );
}

function markDeadLetterForTenant({ pool, tenantId, id }) {
  return withTenantAriOutbox(pool, tenantId, (outbox) => outbox.markDeadLetter(id));
}

/**
 * Expired-lease recovery (correction #2), tenant-bound like every other
 * wrapper here: only THIS tenant's expired PROCESSING rows return to
 * PENDING (RLS scopes the UPDATE; a wrong-tenant call affects zero rows).
 * A still-active lease is never broken; retry_count and attempts are
 * preserved per the store's documented semantics.
 */
function requeueExpiredLeasesForTenant({ pool, tenantId, limit }) {
  return withTenantAriOutbox(pool, tenantId, (outbox) =>
    outbox.requeueExpiredLeases({ limit })
  );
}

module.exports = {
  withTenantAriOutbox,
  enqueueForTenant,
  claimDueForTenant,
  markCompletedForTenant,
  markRetryScheduledForTenant,
  markDeadLetterForTenant,
  requeueExpiredLeasesForTenant
};
