'use strict';

/**
 * Adapter validation layer (Phase 24 B8-A) - enforces the canonical contract:
 *   - interface compliance (all 8 methods + channel)
 *   - lifecycle compliance (init/health/close behave)
 *   - payload-normalization compliance (normalizeBooking yields a canonical shape)
 */

const { CANONICAL_METHODS } = require('./CanonicalOTAAdapter');

function validateInterface(adapter) {
  const missing = CANONICAL_METHODS.filter((m) => !adapter || typeof adapter[m] !== 'function');
  if (!adapter || !adapter.channel) missing.push('channel');
  return { ok: missing.length === 0, missing };
}

async function validateLifecycle(adapter) {
  const errors = [];
  try { await adapter.init(); } catch (e) { errors.push('init: ' + e.message); }
  try {
    const h = await adapter.health();
    if (!h || typeof h.ok !== 'boolean') errors.push('health: must return { ok:boolean }');
  } catch (e) { errors.push('health: ' + e.message); }
  try { await adapter.close(); } catch (e) { errors.push('close: ' + e.message); }
  return { ok: errors.length === 0, errors };
}

function validateNormalization(adapter, sampleRaw) {
  const errors = [];
  try {
    const b = adapter.normalizeBooking(sampleRaw);
    if (!b || typeof b !== 'object') {
      errors.push('normalizeBooking: must return an object');
    } else {
      for (const f of ['bookingId', 'channel', 'status']) {
        if (b[f] == null) errors.push('normalizeBooking: missing ' + f);
      }
    }
  } catch (e) { errors.push('normalizeBooking: ' + e.message); }
  return { ok: errors.length === 0, errors };
}

async function validateAll(adapter, { sampleRaw } = {}) {
  const iface = validateInterface(adapter);
  const lifecycle = iface.ok ? await validateLifecycle(adapter) : { ok: false, errors: ['skipped: interface invalid'] };
  const normalization = (iface.ok && sampleRaw)
    ? validateNormalization(adapter, sampleRaw)
    : { ok: true, errors: [], skipped: !sampleRaw };
  return { ok: iface.ok && lifecycle.ok && normalization.ok, interface: iface, lifecycle, normalization };
}

module.exports = { validateInterface, validateLifecycle, validateNormalization, validateAll };
