'use strict';

/**
 * Mock job processor (Phase 24 B6) - explicitly NO OTA connectivity.
 *
 * Simulates success/failure deterministically so the worker lifecycle (retry,
 * dead-letter, idempotency) is testable. `shouldFail(job)` lets a caller/test
 * drive outcomes: falsy = success, truthy = failure, 'throw' = throw.
 */

const ACTIONS = Object.freeze(['CREATE_BOOKING', 'UPDATE_BOOKING', 'CANCEL_BOOKING', 'CHECK_IN', 'CHECK_OUT']);

function buildMockProcessor({ shouldFail } = {}) {
  return {
    actions: ACTIONS,
    async process(job) {
      if (!job || !ACTIONS.includes(job.action)) return { ok: false, error: 'unknown_action' };
      const verdict = typeof shouldFail === 'function' ? shouldFail(job) : false;
      if (verdict === 'throw') throw new Error('mock_processor_threw');
      if (verdict) return { ok: false, error: 'mock_failure' };
      return { ok: true, result: { action: job.action, reservation_id: job.reservation_id, mocked: true } };
    }
  };
}

module.exports = { buildMockProcessor, ACTIONS };
