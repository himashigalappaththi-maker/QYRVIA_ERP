'use strict';

/**
 * D4 — ARI inventory adjuster (Phase 52; tenant-transaction-bound Phase 66A-B2N-A).
 *
 * Factory: buildAriInventoryAdjuster({ withAriStore })
 * Returns object: { async adjustSold({ tenantId, propertyId, roomTypeId, arrival, departure, delta }) }
 *
 * `withAriStore(tenantId, callback)` is an opaque, injected function — this
 * file has no idea it is backed by runWithTenantTransaction or what an ARI
 * store even looks like beyond `.adjustSold(...)`. The real implementation
 * (src/ari/store/tenantAriStore.js's withTenantAriStore, curried with the
 * boot pool) is wired in at src/index.js.
 *
 * Loops over each night in [arrival, departure) and calls store.adjustSold()
 * per night, ALL inside the ONE unit of work withAriStore opens — Phase
 * 66A-B2N-A's atomicity invariant: a failure on any night rolls back every
 * earlier night in the same multi-night adjustment (no partial commit). If
 * store.adjustSold() returns null for a night (sold floor guard — sold
 * already at 0 and a decrement would go negative), that is a normal,
 * successful query result, not an error: it logs a warning and the loop
 * continues to the remaining nights within the same transaction.
 *
 * IMPORTANT: Must NOT require from ari/ — withAriStore is injected as an
 * opaque function, and the store it hands back is used as an opaque object.
 *
 * Night iteration: from arrival (inclusive) to departure (exclusive), ISO YYYY-MM-DD per night.
 */

const logger = require('../config/logger');

/** UTC-safe next calendar date for a 'YYYY-MM-DD' string (half-open [d, d+1)). */
function nextDate(date) {
  const t = Date.parse(String(date) + 'T00:00:00Z') + 86400000;
  const d = new Date(t);
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}

function nightDates(arrival, departure) {
  const out = [];
  const start = Date.parse(String(arrival) + 'T00:00:00Z');
  const end   = Date.parse(String(departure) + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return out;
  for (let t = start; t < end; t += 86400000) {
    const d = new Date(t);
    out.push(
      d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0')
    );
  }
  return out;
}

function buildAriInventoryAdjuster({ withAriStore } = {}) {
  if (typeof withAriStore !== 'function') {
    throw new Error('buildAriInventoryAdjuster: withAriStore(tenantId, callback) required');
  }

  return {
    async adjustSold({ tenantId, propertyId, roomTypeId, arrival, departure, delta }) {
      const dates = nightDates(arrival, departure);
      if (!dates.length) return;

      // B2N-C1: every emitting path must carry a real property identity —
      // ari_outbox_store.property_id is NOT NULL and its composite FK binds
      // (tenant_id, property_id) to properties(tenant_id, id). Fail BEFORE
      // the authoritative mutation rather than mutate inventory that could
      // never produce its event; never substitute or invent a property.
      if (typeof propertyId !== 'string' || propertyId.length === 0) {
        throw new Error('ariInventoryAdjuster: propertyId is required to emit the ARI outbox event');
      }

      // ONE unit of work for every night in the stay — a thrown error on any
      // night propagates out of this callback, so withAriStore rolls back
      // EVERY night already applied in this same call. No per-night
      // try/catch-and-continue: that was the pre-B2N-A behavior and is
      // exactly the non-atomic pattern this phase removes.
      //
      // B2N-C1: each night that ACTUALLY changed a row also enqueues exactly
      // one INVENTORY_CHANGED event on the SAME transaction-bound client
      // (ariStore.outbox), so the inventory write and its event commit
      // together or roll back together. An enqueue failure is never
      // swallowed here — it propagates out, rolling the whole adjustment
      // back; bookingService's own long-standing catch/log policy then
      // decides what that means for the booking (unchanged by this phase).
      await withAriStore(tenantId, async (ariStore) => {
        for (const date of dates) {
          const result = await ariStore.adjustSold({ tenant_id: tenantId, propertyId, roomTypeId, date, delta });
          if (result === null) {
            // sold floor/ceiling guard: a successful query that matched zero
            // rows. Nothing changed, so there is nothing to announce — no
            // event is emitted for this night, and the nights already
            // applied are not rolled back.
            logger.warn({ tenantId, propertyId, roomTypeId, date, delta }, '[ariInventoryAdjuster] adjustSold returned null (floor guard) — no event emitted, continuing within the same transaction');
            continue;
          }

          if (!ariStore.outbox || typeof ariStore.outbox.enqueue !== 'function') {
            throw new Error('ariInventoryAdjuster: the injected ARI unit exposes no outbox — an inventory mutation must not commit without its event');
          }

          await ariStore.outbox.enqueue({
            tenantId,
            propertyId,
            eventType:     'INVENTORY_CHANGED',
            resourceKind:  'INVENTORY',
            roomTypeId,
            ratePlanId:    null,
            effectiveFrom: date,
            effectiveTo:   nextDate(date),
            sourceVersion: result.version,
            payload: { date, delta, sold: result.sold, source: 'booking_adjustment' }
          });
        }
      });
    }
  };
}

module.exports = { buildAriInventoryAdjuster };
