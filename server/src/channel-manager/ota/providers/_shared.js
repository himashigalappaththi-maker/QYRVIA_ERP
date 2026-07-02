'use strict';

/**
 * Shared provider codec helpers (Phase 30.2).
 *
 * Error/retry classification is HTTP-status based + provider-overridable. A
 * transport-disabled result (default runtime) decodes to a NON-retryable
 * transport_disabled ack so nothing spins on a disabled transport.
 */

/** Which HTTP outcomes are worth retrying (network, rate-limit, server errors). */
function classifyHttpStatus(status) {
  if (status === 0) return true;     // no response / network error
  if (status === 429) return true;   // rate limited
  if (status >= 500) return true;    // upstream server error
  return false;                      // other 4xx (400/401/403/404/409...) -> permanent
}

/** Build a provider decodeAck(op, raw) from an ackId extractor + an error mapper. */
function buildDecodeAck({ extractAckId, mapErrors } = {}) {
  return function decodeAck(op, raw) {
    raw = raw || {};
    if (raw.error === 'transport_disabled') {
      return { ok: false, status: 0, retryable: false, errors: [{ code: 'transport_disabled', message: 'OTA HTTP transport disabled' }], raw };
    }
    const status = raw.status || 0;
    if (raw.ok && status >= 200 && status < 300) {
      return { ok: true, ackId: (extractAckId && extractAckId(raw)) || null, status, errors: [], raw };
    }
    return { ok: false, status, retryable: classifyHttpStatus(status), errors: mapErrors ? mapErrors(raw, status) : [{ code: 'http_' + status }], raw };
  };
}

module.exports = { classifyHttpStatus, buildDecodeAck };
