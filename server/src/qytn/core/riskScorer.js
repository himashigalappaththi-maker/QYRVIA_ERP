'use strict';

/**
 * QTCN risk scorers - pure, deterministic, side-effect-free.
 *
 * All scores are normalized to 0..1.
 */

function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }

/**
 * Cancellation risk from the booking request:
 *   - guest history cancellation rate (dominant signal, weight 0.6)
 *   - refundable rate adds risk (+0.25)
 *   - long lead time (>60d) adds risk (+0.15)
 */
function scoreCancellationRisk(request = {}) {
  const base = clamp01(request.guestCancellationRate);
  const refundable = request.refundable ? 0.25 : 0;
  const longLead = (Number(request.leadTimeDays) || 0) > 60 ? 0.15 : 0;
  return clamp01(0.6 * base + refundable + longLead);
}

/**
 * Inventory mismatch risk for a channel = how far the channel's advertised
 * availability has drifted from PMS truth, from a snapshot's channelAvailability.
 */
function scoreInventoryMismatch(channel, snapshot = {}) {
  const ca = (snapshot.channelAvailability || {})[channel];
  if (!ca) return 0;
  const pms = Number(ca.pmsCount) || 0;
  const ota = Number(ca.otaCount) || 0;
  return clamp01(Math.abs(pms - ota) / Math.max(pms, 1));
}

function maxInventoryMismatch(channels, snapshot = {}) {
  return (channels || []).reduce((m, c) => Math.max(m, scoreInventoryMismatch(c, snapshot)), 0);
}

module.exports = { scoreCancellationRisk, scoreInventoryMismatch, maxInventoryMismatch, clamp01 };
