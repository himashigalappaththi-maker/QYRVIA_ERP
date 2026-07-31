'use strict';

/**
 * Real job processor (Phase 50) — production dispatch path for the channel queue
 * worker. Replaces mockProcessor when CHANNEL_WORKER_REAL=true.
 *
 * Per job:
 *   1. Resolves the OTA transport provider (codec) for the channel.
 *   2. Requires a live per-channel registry authorization (Phase 66A-B2L).
 *   3. Builds a CredentialAuthStrategy that fetches the tenant's secret lazily.
 *   4. Dispatches via buildOtaTransport (HTTP is disabled unless CHANNEL_HTTP_ENABLED=true).
 *   5. Returns { ok, result } or { ok: false, error } for the worker retry/DLQ policy.
 *
 * Channels without a known provider return { ok: false, error: 'no_provider_for_channel' }.
 * That IS retriable (the provider may be added without a deployment) so the worker will
 * retry up to its max before dead-lettering.
 *
 * PHASE 66A-B2L — PER-CHANNEL REGISTRY AUTHORIZATION
 * ────────────────────────────────────────────────────
 * `channelRegistry` is a required, injected dependency (same required-or-throw
 * pattern as `secretProvider`) — a real processor can never be constructed
 * without one, so there is no code path where selecting the real processor
 * alone could authorize dispatch. Every job that would otherwise reach an
 * external adapter/transport call (QYRVIA Connect's in-process transport, or
 * an external OTA's HTTP transport) is first checked against
 * `channelRegistry.get(channel, { tenantId, propertyId })`, fresh, for that
 * job — never cached across jobs, never cached at construction, never
 * inferred from a different channel's state. Only an existing record with
 * `enabled === true` (exact boolean) authorizes the call; an absent record,
 * a disabled record, a non-boolean-true value, or a registry read that
 * throws/rejects all deny identically via the same `{ ok: false,
 * error: 'channel_disabled', skipped: true }` shape already established by
 * channelSyncService.js's own kill-switch check — no new result shape was
 * invented. CHECK_IN/CHECK_OUT never call the registry: they never reach any
 * external transport either (see the local_only branch below), so there is
 * nothing to authorize.
 */

const { CredentialAuthStrategy } = require('../adapters/framework/AuthStrategy');
const { buildOtaTransport, buildDisabledHttp } = require('../ota/transport');
const { buildInProcessTransport } = require('../transport/transport');
const { CHANNELS } = require('../core/canonical/types');
const providers = require('../ota/providers');

const ACTIONS = Object.freeze(['CREATE_BOOKING', 'UPDATE_BOOKING', 'CANCEL_BOOKING', 'CHECK_IN', 'CHECK_OUT']);

function buildRealProcessor({ secretProvider, channelRegistry, http, qtcnTransport, clock, sleep } = {}) {
  if (!secretProvider) throw new Error('realProcessor: secretProvider required');
  if (!channelRegistry) throw new Error('realProcessor: channelRegistry required');
  const _http = http || buildDisabledHttp();
  const _qtcn = qtcnTransport || buildInProcessTransport();

  // Fresh per call, never cached — see the header note above.
  async function isChannelAuthorized(channel, tenantId, propertyId) {
    let reg;
    try {
      reg = await channelRegistry.get(channel, { tenantId, propertyId: propertyId || null });
    } catch (_err) {
      return false;
    }
    return !!(reg && reg.enabled === true);
  }

  return {
    actions: ACTIONS,

    async process(job) {
      if (!job || !ACTIONS.includes(job.action)) return { ok: false, error: 'unknown_action' };

      const { action, channel, tenant_id, property_id, credentials_ref, payload } = job;
      if (!channel)    return { ok: false, error: 'channel_required' };
      if (!tenant_id)  return { ok: false, error: 'tenant_required' };

      // CHECK_IN / CHECK_OUT are PMS-internal; not dispatched to OTA transport.
      // No registry check: neither branch ever reaches an external call.
      if (action === 'CHECK_IN' || action === 'CHECK_OUT') {
        return { ok: true, result: { action, dispatch: 'local_only' } };
      }

      // QYRVIA Connect — QYRVIA-owned B2B OTA/distribution platform. Delivered via
      // in-process transport (loopback sink). Accepts both canonical QYRVIA_CONNECT
      // and legacy QTCN channel codes for backward compat with old queued jobs.
      // Registry authorization is looked up under the canonical code, matching
      // the existing canonicalization of the output `channel` field below.
      if (channel === CHANNELS.QYRVIA_CONNECT || channel === CHANNELS.QTCN) {
        const authorized = await isChannelAuthorized(CHANNELS.QYRVIA_CONNECT, tenant_id, property_id);
        if (!authorized) return { ok: false, error: 'channel_disabled', skipped: true };
        const p = payload || {};
        const status = action === 'CANCEL_BOOKING' ? 'CANCELLED' : (p.status || 'CONFIRMED');
        const ack = await _qtcn.send({ channel, op: action, payload: { ...p, status } });
        if (ack && ack.ok) return { ok: true, result: { action, ackId: ack.ackId, channel: CHANNELS.QYRVIA_CONNECT, dispatch: 'in_process' } };
        return { ok: false, error: (ack && ack.error) || 'qtcn_dispatch_error' };
      }

      // Resolve codec provider for external OTAs. Checked before the registry
      // lookup so an unknown channel never triggers a registry read at all.
      let provider;
      try { provider = providers.getProvider(channel); }
      catch (_) { return { ok: false, error: 'no_provider_for_channel' }; }

      const authorized = await isChannelAuthorized(channel, tenant_id, property_id);
      if (!authorized) return { ok: false, error: 'channel_disabled', skipped: true };

      // Build lazy credential auth strategy. Falls back to empty headers if no
      // credentials_ref is set (non-fatal — transport will fail gracefully).
      const ref = credentials_ref || null;
      const auth = new CredentialAuthStrategy({
        credentialsRef: ref || 'no_ref',
        tenantId: tenant_id,
        secretProvider,
        toHeaders: (secret) => provider.authToHeaders(secret)
      });

      // Build transport with injected HTTP (disabled by default).
      const transport = buildOtaTransport({ provider, http: _http, auth, clock, sleep });

      // Dispatch reservation ack.
      let ack;
      try {
        const p = payload || {};
        const status = action === 'CANCEL_BOOKING' ? 'CANCELLED' : (p.status || 'CONFIRMED');
        ack = await transport.pushReservationAck({ ...p, status });
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }

      if (ack && ack.ok) return { ok: true, result: { action, ackId: ack.ackId, channel } };
      const errCode = (ack && ack.errors && ack.errors[0] && ack.errors[0].code) || 'transport_error';
      return { ok: false, error: errCode };
    }
  };
}

module.exports = { buildRealProcessor, ACTIONS };
