'use strict';

/**
 * Queue parity tooling (Phase 24 B5).
 *
 * Compares two queue implementations (typically the in-memory queue vs the DB
 * queue during `dual` mode) on logical state - counts, per-status counts, and
 * the multiset of (reservation_id, action, status) keys. Surrogate ids (q_N vs
 * uuid) are intentionally ignored; only business-meaningful state is compared.
 *
 * Read-only: it never mutates either queue. Works with sync (memory) or async
 * (db) `list()` via Promise.resolve.
 */

async function snapshot(queue) {
  const items = await Promise.resolve(queue.list());
  const byStatus = items.reduce((acc, x) => { acc[x.status] = (acc[x.status] || 0) + 1; return acc; }, {});
  return { count: items.length, byStatus, items };
}

const logicalKey = (x) => `${x.reservation_id}::${x.action}::${x.status}`;

// Multiset difference: elements of `a` not covered by `b` (respecting duplicates).
function multisetDiff(a, b) {
  const rest = b.slice();
  const out = [];
  for (const x of a) {
    const i = rest.indexOf(x);
    if (i >= 0) rest.splice(i, 1); else out.push(x);
  }
  return out;
}

async function compareQueues(memQueue, dbQueue) {
  const m = await snapshot(memQueue);
  const d = await snapshot(dbQueue);
  const mKeys = m.items.map(logicalKey).sort();
  const dKeys = d.items.map(logicalKey).sort();

  const mismatches = [];
  if (m.count !== d.count) mismatches.push({ type: 'count', memory: m.count, db: d.count });

  const memoryOnly = multisetDiff(mKeys, dKeys);
  const dbOnly     = multisetDiff(dKeys, mKeys);
  if (memoryOnly.length || dbOnly.length) mismatches.push({ type: 'state', memoryOnly, dbOnly });

  return {
    ok: mismatches.length === 0,
    memCount: m.count,
    dbCount: d.count,
    memByStatus: m.byStatus,
    dbByStatus: d.byStatus,
    mismatches
  };
}

module.exports = { compareQueues, snapshot };
