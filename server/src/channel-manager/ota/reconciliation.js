'use strict';

/**
 * Reconciliation engine (Phase 30.2) - pure + deterministic.
 *
 * Compares a LOCAL snapshot (QYRVIA's source of truth) against a REMOTE snapshot
 * (what the OTA reports) and produces a drift report plus recovery recommendations.
 * Detects three drift classes - inventory, rate, reservation - each as one of:
 *   missing_remote  (local has it, OTA doesn't)  -> push to OTA
 *   missing_local   (OTA has it, local doesn't)  -> ingest / investigate
 *   value_mismatch  (both have it, differ)       -> resync
 *
 * No I/O: callers supply the two snapshots; persistence is separate (store).
 */

function indexBy(arr, key) { const m = new Map(); for (const x of arr || []) m.set(String(x[key]), x); return m; }

function driftFor(localArr, remoteArr, key, equal) {
  const L = indexBy(localArr, key), R = indexBy(remoteArr, key);
  const out = [];
  for (const k of [...new Set([...L.keys(), ...R.keys()])].sort()) {  // deterministic order
    const l = L.get(k), r = R.get(k);
    if (l && !r) out.push({ key: k, type: 'missing_remote', local: l, remote: null });
    else if (!l && r) out.push({ key: k, type: 'missing_local', local: null, remote: r });
    else if (!equal(l, r)) out.push({ key: k, type: 'value_mismatch', local: l, remote: r });
  }
  return out;
}

const RECO = {
  inventory: { missing_remote: 'push_inventory', missing_local: 'investigate_remote_inventory', value_mismatch: 'resync_inventory' },
  rate: { missing_remote: 'push_rate', missing_local: 'investigate_remote_rate', value_mismatch: 'resync_rate' },
  reservation: { missing_remote: 'investigate_local_reservation', missing_local: 'ingest_reservation', value_mismatch: 'resolve_reservation_status' }
};

function recommendations(channel, kind, drifts) {
  return drifts.map((d) => ({ channel, kind, key: d.key, drift_type: d.type, action: RECO[kind][d.type], resource_key: d.key }));
}

/**
 * snapshots: { inventory:[{key,available,stopSell}], rates:[{key,rate,currency}], reservations:[{id,status}] }
 * Returns { channel, inventoryDrift, rateDrift, reservationDrift, recommendations, hasDrift }.
 */
function reconcile({ channel = null, local = {}, remote = {} } = {}) {
  const inventoryDrift = driftFor(local.inventory, remote.inventory, 'key', (a, b) => a.available === b.available && !!a.stopSell === !!b.stopSell);
  const rateDrift = driftFor(local.rates, remote.rates, 'key', (a, b) => Number(a.rate) === Number(b.rate) && (a.currency || null) === (b.currency || null));
  const reservationDrift = driftFor(local.reservations, remote.reservations, 'id', (a, b) => a.status === b.status);

  const recs = [].concat(
    recommendations(channel, 'inventory', inventoryDrift),
    recommendations(channel, 'rate', rateDrift),
    recommendations(channel, 'reservation', reservationDrift)
  );

  return {
    channel,
    inventoryDrift, rateDrift, reservationDrift,
    recommendations: recs,
    hasDrift: recs.length > 0,
    counts: { inventory: inventoryDrift.length, rate: rateDrift.length, reservation: reservationDrift.length }
  };
}

module.exports = { reconcile, driftFor };
