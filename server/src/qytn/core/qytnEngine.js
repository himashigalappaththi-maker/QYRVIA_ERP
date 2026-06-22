'use strict';

/**
 * QTCN engine - QYRVIA Transaction & Channel Network.
 *
 * A STATELESS revenue-routing decision engine that sits above the Channel
 * Manager. It is a PURE FUNCTION + rules engine:
 *   - No DB writes, no API calls, no I/O, no imports of CM/PMS.
 *   - Input  = booking request + inventory snapshot.
 *   - Output = a routing decision (where the booking should be fulfilled).
 *
 *   const { decide } = require('./qytnEngine');
 *   const decision = decide({ request, snapshot });
 *
 * Execution of the decision (actually routing to the direct path or to an OTA
 * via the Channel Manager) is the integration layer's job - see
 * integrations/channelManagerBridge.js. QTCN only decides.
 */

const { makeDecision } = require('../models/qytnDecision');
const matrixMod = require('./priorityMatrix');
const scorer = require('./riskScorer');
const rules = require('./routingRules');

function decide({ request, snapshot } = {}, opts = {}) {
  if (!request || typeof request !== 'object') throw new Error('qytnEngine.decide: request required');
  const snap = snapshot || {};
  const matrix = opts.matrix || matrixMod.CHANNELS;
  const thresholds = opts.thresholds || matrixMod.THRESHOLDS;
  const directChannel = opts.directChannel || matrixMod.DIRECT_CHANNEL;

  // Candidate OTAs = matrix universe ∩ snapshot availability, sorted cheapest-first.
  const universe = matrixMod.listOtas();
  const available = Array.isArray(snap.availableChannels) ? snap.availableChannels : universe.concat([directChannel]);
  const availableOtas = universe
    .filter((c) => available.includes(c))
    .sort((a, b) => matrix[a].commissionPct - matrix[b].commissionPct);

  const cancellationRisk = scorer.scoreCancellationRisk(request);
  const maxMismatch = scorer.maxInventoryMismatch(availableOtas, snap);
  const strictestOta = availableOtas.slice()
    .sort((a, b) => matrix[b].strictness - matrix[a].strictness)[0] || directChannel;

  const ctx = {
    request, snapshot: snap, matrix, thresholds, directChannel,
    availableOtas, cancellationRisk, maxMismatch, strictestOta
  };

  const raw = rules.evaluate(ctx);
  raw.reasoning = ['cancellationRisk=' + cancellationRisk.toFixed(2) + ' maxMismatch=' + maxMismatch.toFixed(2)]
    .concat(raw.reasoning);
  return makeDecision(raw, { idGen: opts.idGen });
}

module.exports = { decide };
