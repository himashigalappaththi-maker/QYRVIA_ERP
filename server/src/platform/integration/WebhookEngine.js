'use strict';

/**
 * WebhookEngine (Phase 18) - inbound webhook handling for OTA updates, external
 * triggers, and payment callbacks. Features: HMAC signature verification,
 * idempotency keys (dedupe), and a retry queue for failed processing.
 */

const crypto = require('crypto');

function sign(payload, secret) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  return crypto.createHmac('sha256', String(secret)).update(body).digest('hex');
}

function buildWebhookEngine({ clock, maxAttempts = 5 } = {}) {
  const now = clock || (() => Date.now());
  const seen = new Set();          // idempotency keys
  const queue = [];                // pending/failed deliveries
  const deadLetter = [];

  return {
    sign,
    /**
     * Verify + accept a webhook. Returns {ok, verified, deduped, queued}.
     * Duplicate idempotencyKey is dropped; bad signature is rejected.
     */
    receive({ source, payload, signature, idempotencyKey, secret } = {}) {
      if (secret != null) {
        const expected = sign(payload, secret);
        if (signature !== expected) return { ok: false, verified: false, error: 'invalid_signature' };
      }
      if (idempotencyKey) {
        if (seen.has(idempotencyKey)) return { ok: true, verified: true, deduped: true };
        seen.add(idempotencyKey);
      }
      const job = { id: crypto.randomUUID(), source, payload, idempotencyKey: idempotencyKey || null, attempts: 0, receivedAt: now() };
      queue.push(job);
      return { ok: true, verified: true, deduped: false, queued: true, jobId: job.id };
    },

    /** Drain the queue with `handler(job)`; failures retry up to maxAttempts then dead-letter. */
    async processQueue(handler) {
      const results = [];
      while (queue.length > 0) {
        const job = queue.shift();
        job.attempts += 1;
        try {
          // eslint-disable-next-line no-await-in-loop
          const out = await handler(job);
          results.push({ id: job.id, ok: true, value: out });
        } catch (e) {
          if (job.attempts < maxAttempts) { queue.push(job); }
          else { deadLetter.push({ id: job.id, error: String(e.message || e), attempts: job.attempts }); results.push({ id: job.id, ok: false, deadLettered: true }); }
        }
      }
      return results;
    },

    pending() { return queue.length; },
    deadLetters() { return deadLetter.slice(); }
  };
}

module.exports = { buildWebhookEngine, sign };
