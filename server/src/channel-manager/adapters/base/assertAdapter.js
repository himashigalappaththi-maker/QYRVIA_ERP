'use strict';

/**
 * Phase 10.2 - OTA scaling contract (the "one OTA = one file" base).
 *
 * This is ADDITIVE and independent of the Phase 10.0 `base/OTAAdapter.js`
 * (which has a different, six-method contract used by the Channel Manager core
 * + its tests). Phase 10.2 introduces the scalable 5-method contract:
 *
 *   async pullAvailability(query)  -> normalized availability[]
 *   async pushRates(rate)          -> normalized ack
 *   async pushInventory(inv)       -> normalized ack
 *   async createBooking(req)       -> normalized booking
 *   async cancelBooking(id)        -> normalized booking (CANCELLED)
 *
 * Rules: every method is async, returns a normalized canonical shape, and
 * NEVER touches the DB. The base provides working mock defaults keyed off
 * `this.channel`, so a new OTA is a tiny file that only declares its identity.
 * No OTA-specific branching lives in any shared layer.
 */

const REQUIRED_METHODS = ['pullAvailability', 'pushRates', 'pushInventory', 'createBooking', 'cancelBooking'];

class OTAAdapter {
  constructor(channel, opts = {}) {
    if (!channel) throw new Error('OTAAdapter: channel required');
    this.channel = channel;
    this.commissionPct = opts.commissionPct != null ? opts.commissionPct : null;
  }

  async pullAvailability(query = {}) {
    return [this._availability(query)];
  }

  async pushRates(rate = {}) {
    return this._ack('pushRates', rate);
  }

  async pushInventory(inv = {}) {
    return this._ack('pushInventory', inv);
  }

  async createBooking(req = {}) {
    return this._booking(req, 'CONFIRMED');
  }

  async cancelBooking(bookingId) {
    return { channel: this.channel, bookingId: String(bookingId), status: 'CANCELLED' };
  }

  // ---- normalized shape helpers (shared by every adapter) -----------------
  _ack(op, payload) {
    return { ok: true, channel: this.channel, op, applied: payload || {} };
  }
  _availability(q) {
    return {
      channel: this.channel,
      propertyId: q.propertyId || null,
      roomTypeId: q.roomTypeId || null,
      date: q.date || null,
      available: q.available != null ? Number(q.available) : 1
    };
  }
  _booking(req, status) {
    const ref = req.ref || req.bookingId || 'B';
    return {
      channel: this.channel,
      bookingId: this.channel + ':' + ref,
      status,
      guestName: req.guestName || null,
      propertyId: req.propertyId || null,
      roomTypeId: req.roomTypeId || null,
      arrival: req.arrival || null,
      departure: req.departure || null,
      amount: req.amount != null ? Number(req.amount) : null,
      currency: req.currency || null,
      commissionPct: this.commissionPct
    };
  }
}

/**
 * Validate that an object satisfies the 5-method async contract.
 * Returns { ok, missing[], notAsync[] }.
 */
function assertAdapter(adapter) {
  const missing = [];
  const notAsync = [];
  if (!adapter || !adapter.channel) missing.push('channel');
  for (const m of REQUIRED_METHODS) {
    const fn = adapter && adapter[m];
    if (typeof fn !== 'function') { missing.push(m); continue; }
    if (fn.constructor && fn.constructor.name !== 'AsyncFunction') notAsync.push(m);
  }
  return { ok: missing.length === 0 && notAsync.length === 0, missing, notAsync };
}

module.exports = { OTAAdapter, assertAdapter, REQUIRED_METHODS };
