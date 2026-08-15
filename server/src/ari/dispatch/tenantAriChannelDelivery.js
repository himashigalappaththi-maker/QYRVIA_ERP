'use strict';

/**
 * Phase 68A — tenant-bound access to the durable ARI channel delivery ledger,
 * mirroring src/ari/outbox/tenantAriOutbox.js exactly.
 *
 * withTenantAriChannelDelivery(pool, tenantId, callback) opens (or joins) ONE
 * tenant-bound READ/WRITE unit of work via src/db/tenantUnitOfWork.js and
 * hands the callback a store bound to that transaction's client. Because
 * runWithTenantTransaction reuses an already-open same-tenant unit of work
 * (AsyncLocalStorage join — never a second connection or BEGIN) and fails
 * closed on a cross-tenant nested call, a dispatcher can call
 * ensureDeliveryForTenant(...) and claimForTenant(...) for several channels
 * of the SAME ARI event without opening a new transaction per channel, and —
 * when the caller is already inside the ARI outbox's own tenant-bound unit
 * of work — WITHOUT a second connection at all.
 *
 * There is NO bare-pool fallback (the table is FORCE RLS; tenantUnitOfWork
 * throws TENANT_CONTEXT_REQUIRED/TENANT_ID_INVALID before any SQL), and no
 * manual SET SESSION anywhere.
 */

const { runWithTenantTransaction, runWithTenantRead } = require('../../db/tenantUnitOfWork');
const { buildAriChannelDeliveryStore, allRequiredChannelsComplete, STATUS, ERROR_CLASS, CANONICAL_CHANNELS } =
  require('./ariChannelDeliveryStore');

function withTenantAriChannelDelivery(pool, tenantId, callback) {
  return runWithTenantTransaction(pool, tenantId, (client) =>
    callback(buildAriChannelDeliveryStore({ db: client }))
  );
}

/** Read-only variant — used for pre-dispatch inspection that must never accidentally write. */
function withTenantAriChannelDeliveryRead(pool, tenantId, callback) {
  return runWithTenantRead(pool, tenantId, (client) =>
    callback(buildAriChannelDeliveryStore({ db: client }))
  );
}

function ensureDeliveryForTenant({ pool, tenantId, propertyId, ariOutboxId, channelCode, dedupeKey, sourceVersion }) {
  return withTenantAriChannelDelivery(pool, tenantId, (store) =>
    store.ensureDelivery({ tenantId, propertyId, ariOutboxId, channelCode, dedupeKey, sourceVersion })
  );
}

function listForOutboxEventForTenant({ pool, tenantId, ariOutboxId }) {
  return withTenantAriChannelDeliveryRead(pool, tenantId, (store) =>
    store.listForOutboxEvent(ariOutboxId)
  );
}

function claimForTenant({ pool, tenantId, id }) {
  return withTenantAriChannelDelivery(pool, tenantId, (store) => store.claim(id));
}

function markCompletedForTenant({ pool, tenantId, id, providerAckId }) {
  return withTenantAriChannelDelivery(pool, tenantId, (store) =>
    store.markCompleted(id, { providerAckId })
  );
}

function markRetryForTenant({ pool, tenantId, id, errorCode, errorClass }) {
  return withTenantAriChannelDelivery(pool, tenantId, (store) =>
    store.markRetry(id, { errorCode, errorClass })
  );
}

function markDeadLetterForTenant({ pool, tenantId, id, errorCode, errorClass }) {
  return withTenantAriChannelDelivery(pool, tenantId, (store) =>
    store.markDeadLetter(id, { errorCode, errorClass })
  );
}

module.exports = {
  withTenantAriChannelDelivery,
  withTenantAriChannelDeliveryRead,
  ensureDeliveryForTenant,
  listForOutboxEventForTenant,
  claimForTenant,
  markCompletedForTenant,
  markRetryForTenant,
  markDeadLetterForTenant,
  allRequiredChannelsComplete,
  STATUS,
  ERROR_CLASS,
  CANONICAL_CHANNELS
};
