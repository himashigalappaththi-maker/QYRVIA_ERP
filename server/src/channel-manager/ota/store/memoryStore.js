'use strict';

/**
 * In-memory OTA store (Phase 30.2) - deterministic backing for unit tests + the
 * default runtime. Mirrors the DB store contract: idempotent sync-attempt recording
 * (by tenant + idempotency key), drift records, and per-channel transport health.
 */

function buildOtaMemoryStore() {
  const attempts = [];
  const seen = new Set();        // tenant|idempotencyKey -> dedupe
  const drift = [];
  const health = new Map();      // tenant|channel -> row
  let seq = 0;

  return {
    async recordAttempt({ tenant_id, propertyId = null, channel, op, status, attempts: n = 1, errorCode = null, idempotencyKey = null } = {}) {
      if (idempotencyKey) {
        const k = tenant_id + '|' + idempotencyKey;
        if (seen.has(k)) return { accepted: false, deduped: true };
        seen.add(k);
      }
      const rec = { id: 'att-' + (++seq), tenant_id, property_id: propertyId, channel, op, status, attempts: n, error_code: errorCode, idempotency_key: idempotencyKey, created_at: Date.now() };
      attempts.push(rec);
      return { accepted: true, id: rec.id };
    },
    async listAttempts({ tenant_id, channel } = {}) {
      return attempts.filter((a) => (!tenant_id || a.tenant_id === tenant_id) && (!channel || a.channel === channel));
    },
    async recordDrift(rows = []) { for (const r of rows) drift.push(Object.assign({ id: 'drift-' + (++seq), detected_at: Date.now() }, r)); return { inserted: rows.length }; },
    async listDrift({ tenant_id, channel } = {}) { return drift.filter((d) => (!tenant_id || d.tenant_id === tenant_id) && (!channel || d.channel === channel)); },
    async upsertHealth({ tenant_id, channel, status, consecutiveFailures = 0, lastError = null } = {}) {
      const k = tenant_id + '|' + channel;
      const prev = health.get(k) || {};
      health.set(k, { tenant_id, channel, status, consecutive_failures: consecutiveFailures, last_error: lastError, last_ok_at: consecutiveFailures === 0 ? Date.now() : (prev.last_ok_at || null), updated_at: Date.now() });
      return health.get(k);
    },
    async getHealth(tenant_id, channel) { return health.get(tenant_id + '|' + channel) || null; }
  };
}

module.exports = { buildOtaMemoryStore };
