'use strict';

/**
 * QTCN decision output model (Phase 10.1).
 *
 *   {
 *     decisionId,
 *     route: "DIRECT" | "OTA",
 *     selectedChannel: "QTCN" | "booking.com" | "agoda" | ...,
 *     confidenceScore,        // 0..1
 *     reasoning: [],          // human-readable rule trace
 *     fallbackChain: []       // ordered alternative channels
 *   }
 *
 * Pure factory - the only non-deterministic bit is `decisionId`, which is
 * injectable so tests stay deterministic.
 */

const crypto = require('crypto');

const ROUTES = Object.freeze({ DIRECT: 'DIRECT', OTA: 'OTA' });

function makeDecision({ route, selectedChannel, confidenceScore = 0, reasoning = [], fallbackChain = [] }, { idGen } = {}) {
  if (route !== ROUTES.DIRECT && route !== ROUTES.OTA) {
    throw new Error('qytnDecision: route must be DIRECT or OTA, got ' + JSON.stringify(route));
  }
  if (!selectedChannel) throw new Error('qytnDecision: selectedChannel required');
  const score = Math.max(0, Math.min(1, Number(confidenceScore) || 0));
  return Object.freeze({
    decisionId: (idGen ? idGen() : crypto.randomUUID()),
    route,
    selectedChannel,
    confidenceScore: score,
    reasoning: Object.freeze(reasoning.slice()),
    fallbackChain: Object.freeze(fallbackChain.slice())
  });
}

module.exports = { makeDecision, ROUTES };
