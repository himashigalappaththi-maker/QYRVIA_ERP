'use strict';

/**
 * AI Booking Confirmation factory (Phase 27.3, DI entry point). Builds the
 * confirmation service from config (auto-send mode, confidence threshold, mock
 * transport) and exposes its `onEvent` hook for the Booking Engine. Default OFF:
 * the caller only builds this when AI_CONFIRMATION_ENABLED='true', so when disabled
 * the Booking Engine runs with no onEvent (zero overhead, zero behavior change).
 *
 * No PMS/OTA/worker/queue/webhook/UI changes; consumes booking events only.
 */

const env = require('../config/env');
const { buildConfirmationService, buildMockConfirmationTransport } = require('./confirmationService');
const { buildConfirmationQueue } = require('./confirmationQueue');
const { renderConfirmation, listTemplates } = require('./confirmationTemplates');
const { decideConfirmation } = require('./escalationPolicy');

function buildAiConfirmation(opts = {}) {
  const autoSend = opts.autoSend != null ? opts.autoSend : (env.AI_CONFIRMATION_AUTO_SEND !== 'false');
  const minConfidence = opts.minConfidence != null ? opts.minConfidence : Number(env.AI_CONFIRMATION_MIN_CONFIDENCE || '0.5');
  const service = buildConfirmationService(Object.assign({ autoSend, minConfidence }, opts));
  return {
    service,
    onEvent: service.onEvent,
    queue: service.queue,
    transport: service.transport,
    escalations: service.escalations,
    suppressed: service.suppressed
  };
}

module.exports = {
  buildAiConfirmation,
  buildConfirmationService,
  buildConfirmationQueue,
  buildMockConfirmationTransport,
  renderConfirmation,
  listTemplates,
  decideConfirmation
};
