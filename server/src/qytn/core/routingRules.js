'use strict';

/**
 * QTCN routing rules (MVP) - a deterministic, ordered rule chain. Pure: given
 * the same ctx it always yields the same routing shape. `evaluate(ctx)` returns
 * the raw decision fields (before decisionId is attached by the engine).
 *
 * Order (first match wins):
 *   1. DIRECT_REQUEST                 -> DIRECT (QTCN)
 *   2. lowest OTA commission > 18%    -> DIRECT (QTCN)   (also: no OTA available)
 *   3. inventory mismatch risk > thr  -> DIRECT (QTCN)   (fallback)
 *   4. high cancellation risk         -> OTA with strictest policy
 *   5. otherwise                      -> lowest-cost OTA
 */

function direct(ctx, confidenceScore, reasoning) {
  return {
    route: 'DIRECT', selectedChannel: ctx.directChannel, confidenceScore, reasoning,
    fallbackChain: ctx.availableOtas.slice()           // OTAs (cheapest first) back up the direct path
  };
}

function ota(ctx, channel, confidenceScore, reasoning) {
  return {
    route: 'OTA', selectedChannel: channel, confidenceScore, reasoning,
    fallbackChain: [ctx.directChannel].concat(ctx.availableOtas.filter((c) => c !== channel))
  };
}

function evaluate(ctx) {
  const { request, thresholds, matrix } = ctx;
  const reasoning = [];
  const cheapest = ctx.availableOtas[0] || null;

  // 1
  if (request.directRequest) {
    reasoning.push('direct_request -> QTCN');
    return direct(ctx, 1.0, reasoning);
  }

  // 2 (no OTA, or cheapest commission over threshold)
  if (!cheapest) {
    reasoning.push('no_ota_available -> QTCN');
    return direct(ctx, 0.9, reasoning);
  }
  const cheapestCommission = matrix[cheapest].commissionPct;
  if (cheapestCommission > thresholds.commissionDirectPct) {
    reasoning.push('lowest_ota_commission ' + cheapestCommission + '% > ' + thresholds.commissionDirectPct + '% -> QTCN direct');
    return direct(ctx, 0.85, reasoning);
  }

  // 3
  if (ctx.maxMismatch > thresholds.inventoryMismatch) {
    reasoning.push('inventory_mismatch_risk ' + ctx.maxMismatch.toFixed(2) + ' > ' + thresholds.inventoryMismatch + ' -> QTCN fallback');
    return direct(ctx, 0.8, reasoning);
  }

  // 4
  if (ctx.cancellationRisk > thresholds.highCancellation) {
    reasoning.push('high_cancellation_risk ' + ctx.cancellationRisk.toFixed(2) + ' -> strict OTA ' + ctx.strictestOta);
    return ota(ctx, ctx.strictestOta, 0.7, reasoning);
  }

  // 5
  reasoning.push('default -> lowest_cost_ota ' + cheapest + ' (' + cheapestCommission + '%)');
  return ota(ctx, cheapest, 0.6, reasoning);
}

module.exports = { evaluate };
