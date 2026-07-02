'use strict';

/**
 * Sync monitoring (Phase 30.2) - tracks outbound sync outcomes and transport
 * health. Deterministic in-memory aggregation (injectable clock); optionally
 * write-through to a store for durable visibility + DLQ counts.
 *
 * Health model: consecutive failures escalate healthy -> degraded -> down.
 */

const DEGRADED_AT = 1;   // >=1 consecutive failure => degraded
const DOWN_AT = 3;       // >=3 consecutive failures => down

function healthStatus(consecutiveFailures) {
  if (consecutiveFailures >= DOWN_AT) return 'down';
  if (consecutiveFailures >= DEGRADED_AT) return 'degraded';
  return 'healthy';
}

function buildSyncMonitor({ store = null, clock = () => Date.now() } = {}) {
  const m = new Map();  // channel -> { total, ok, failed, retries, byOp, consecutiveFailures, lastOkAt, lastError }
  const cell = (ch) => {
    if (!m.has(ch)) m.set(ch, { total: 0, ok: 0, failed: 0, retries: 0, byOp: {}, consecutiveFailures: 0, lastOkAt: null, lastError: null });
    return m.get(ch);
  };

  async function recordAttempt({ tenant_id, propertyId = null, channel, op, ok, attempts = 1, errorCode = null, idempotencyKey = null } = {}) {
    const c = cell(channel);
    c.total += 1;
    c.retries += Math.max(0, (attempts || 1) - 1);
    c.byOp[op] = c.byOp[op] || { total: 0, ok: 0, failed: 0 };
    c.byOp[op].total += 1;
    if (ok) { c.ok += 1; c.byOp[op].ok += 1; c.consecutiveFailures = 0; c.lastOkAt = clock(); }
    else { c.failed += 1; c.byOp[op].failed += 1; c.consecutiveFailures += 1; c.lastError = errorCode || 'error'; }

    if (store && typeof store.recordAttempt === 'function') {
      await Promise.resolve(store.recordAttempt({ tenant_id, propertyId, channel, op, status: ok ? 'OK' : 'FAILED', attempts, errorCode, idempotencyKey }));
    }
    if (store && typeof store.upsertHealth === 'function') {
      await Promise.resolve(store.upsertHealth({ tenant_id, channel, status: healthStatus(c.consecutiveFailures), consecutiveFailures: c.consecutiveFailures, lastError: c.lastError }));
    }
    return { ok: !!ok };
  }

  function metrics(channel) {
    const c = m.get(channel);
    if (!c) return { channel, total: 0, ok: 0, failed: 0, retries: 0, retryRate: 0, successRate: 1, byOp: {} };
    return {
      channel, total: c.total, ok: c.ok, failed: c.failed, retries: c.retries,
      retryRate: c.total ? c.retries / c.total : 0,
      successRate: c.total ? c.ok / c.total : 1,
      byOp: c.byOp
    };
  }

  function health(channel) {
    const c = m.get(channel) || { consecutiveFailures: 0, lastOkAt: null, lastError: null };
    return { channel, status: healthStatus(c.consecutiveFailures), consecutiveFailures: c.consecutiveFailures, lastOkAt: c.lastOkAt, lastError: c.lastError };
  }

  /** DLQ visibility: counts dead-lettered items (per-channel) from a DLQ store/list. */
  function dlqVisibility(deadLetters = []) {
    const byChannel = {};
    for (const d of deadLetters) { const ch = d.channel || 'unknown'; byChannel[ch] = (byChannel[ch] || 0) + 1; }
    return { total: deadLetters.length, byChannel };
  }

  return { recordAttempt, metrics, health, dlqVisibility, healthStatus };
}

module.exports = { buildSyncMonitor, healthStatus };
