'use strict';

/**
 * AuditLogAggregator (Phase 18) - a centralized, append-only, immutable audit
 * stream fed (read-only) from upstream events + gateway permission checks.
 * Entries are frozen and there is no update/delete API - immutability by design.
 */

const crypto = require('crypto');

function buildAuditLogAggregator({ clock, max = 50000 } = {}) {
  const now = clock || (() => Date.now());
  const stream = [];

  return {
    async ingest(entry = {}) {
      const rec = Object.freeze(Object.assign({
        id: crypto.randomUUID(),
        at: new Date(now()).toISOString()
      }, entry));
      stream.push(rec);
      if (stream.length > max) stream.shift();
      return rec;
    },
    list({ propertyId, type, since } = {}) {
      return stream.filter((e) =>
        (!propertyId || e.propertyId === propertyId)        // multi-property scoping
        && (!type || e.type === type)
        && (!since || e.at >= since));
    },
    size() { return stream.length; }
    // intentionally no update/delete: the audit stream is immutable
  };
}

module.exports = { buildAuditLogAggregator };
