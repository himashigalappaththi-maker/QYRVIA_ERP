'use strict';

/**
 * TransportOTAAdapter (Phase 24 B8-B3) - a REAL (non-mock) canonical adapter that
 * delivers outbound pushes through an injected transport. For QYRVIA_CONNECT the
 * transport is in-process (QYRVIA-owned B2B OTA/distribution platform); for
 * third-party OTAs it would be an (HTTP) transport — wired but disabled by default.
 *
 * Satisfies the canonical 8-method contract; auth resolves only via AuthStrategy
 * (credentials_ref), never raw secrets.
 */

const { CanonicalOTAAdapter } = require('./CanonicalOTAAdapter');
const { NoopAuthStrategy } = require('./AuthStrategy');
const { makeCanonicalBooking } = require('../../core/canonical/CanonicalBooking');

class TransportOTAAdapter extends CanonicalOTAAdapter {
  constructor({ channel, transport, auth, endpoint = null, mapRate, mapAvailability, mapReservation } = {}) {
    super({ channel, auth: auth || new NoopAuthStrategy() });
    if (!transport) throw new Error('TransportOTAAdapter: transport required');
    this._t = transport;
    this._endpoint = endpoint;
    this._mapRate = mapRate || ((r) => r);
    this._mapAvailability = mapAvailability || ((i) => i);
    this._mapReservation = mapReservation || ((b) => b);
  }

  async init() { /* transport is ready on construction; real adapters validate creds here */ }
  async health() {
    const h = this._t.health ? await this._t.health() : { ok: true };
    return { ok: !!h.ok, channel: this.channel, transport: this._t.kind };
  }
  async close() { if (this._t.close) await this._t.close(); }

  normalizeBooking(raw) {
    return makeCanonicalBooking({
      bookingId: raw.id || raw.bookingId, channel: this.channel,
      status: raw.status || 'PENDING', externalRef: raw.id || raw.bookingId, raw
    });
  }

  // Resolve auth headers per call (never cached); the secret is resolved by the
  // AuthStrategy via the SecretProvider (credentials_ref), never handled here.
  async _send(op, payload) {
    const headers = (this.auth && typeof this.auth.getAuthHeaders === 'function') ? await this.auth.getAuthHeaders() : {};
    return this._t.send({ channel: this.channel, op, endpoint: this._endpoint, headers, payload });
  }
  async pushReservation(booking) { return this._send('pushReservation', this._mapReservation(booking)); }
  async pushAvailability(inv)    { return this._send('pushAvailability', this._mapAvailability(inv)); }
  async pushRateUpdate(rate)     { return this._send('pushRateUpdate', this._mapRate(rate)); }

  handleWebhook(req) {
    const raw = (req && (req.bookings || req.payload)) || [];
    const list = Array.isArray(raw) ? raw : [raw];
    return { verified: true, events: list.map((r) => this.normalizeBooking(r)) };
  }
}

module.exports = { TransportOTAAdapter };
