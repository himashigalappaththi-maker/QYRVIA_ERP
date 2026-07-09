'use strict';

/**
 * channelConnectionTester (Phase 37 WI-2a) - a READ-ONLY, side-effect-free
 * "test connection" / sandbox readiness probe for a single channel. It answers
 * one question: is this channel wired and ready to communicate?
 *
 *   adapter registered  -> channelManager.getAdapter(channel) resolves
 *   transport healthy    -> adapter.health().ok    (NO network: a DISABLED HTTP
 *                           transport reports ok:false here without ever calling
 *                           send()/fetch(); health() is a lightweight gate only)
 *   credentials present  -> adapter.auth.isValid()  (PRESENCE ONLY - the secret is
 *                           NEVER resolved, read, logged, or returned; an adapter
 *                           with no auth strategy needs no external secret and is
 *                           treated as satisfied, e.g. QYRVIA Connect / in-process adapters)
 *
 * FAIL-CLOSED: a channel connection is tenant-scoped (credentials live per tenant),
 * so a missing tenant context yields { ready:false, reason:'tenant_context_required' }
 * and no probe runs - it never assumes ready.
 *
 * SANDBOX: mode is always 'sandbox'. This never enables live transport, sends a
 * real request, or performs OTA certification.
 *
 *   test(channel, ctx) ->
 *     { channel, ready, mode:'sandbox',
 *       checks: { adapter:bool, transport:{ ok:bool, kind:string|null }, credentials:bool },
 *       reason? }   // reason present only when ready === false
 */

function buildChannelConnectionTester({ channelManager } = {}) {
  if (!channelManager) throw new Error('channelConnectionTester: channelManager required');

  function result(channel, { adapter = false, transport = { ok: false, kind: null }, credentials = false } = {}, reason) {
    const ready = !!adapter && !!transport.ok && !!credentials && !reason;
    const out = {
      channel: channel || null,
      ready,
      mode: 'sandbox',
      checks: { adapter: !!adapter, transport: { ok: !!transport.ok, kind: transport.kind || null }, credentials: !!credentials }
    };
    if (!ready && reason) out.reason = reason;
    return out;
  }

  return {
    async test(channel, ctx = {}) {
      // Fail closed before any probe: no tenant context => not ready.
      if (!ctx || !ctx.tenantId) return result(channel, {}, 'tenant_context_required');
      if (!channel) return result(channel, {}, 'channel_required');

      // Adapter registered? getAdapter throws when absent -> a failed adapter check.
      let adapter;
      try { adapter = channelManager.getAdapter(channel); }
      catch (_) { return result(channel, { adapter: false }, 'adapter_not_registered'); }

      // Transport health - NO network. A disabled HTTP transport returns ok:false
      // here without calling out; a thrown health() is treated as unhealthy.
      let health;
      try { health = adapter.health ? await adapter.health() : { ok: true }; }
      catch (_) { health = { ok: false }; }
      const transport = { ok: !!(health && health.ok), kind: (health && health.transport) || null };

      // Credentials PRESENCE only - never resolves the secret. No auth strategy =>
      // no external secret required => satisfied.
      const credentials = adapter.auth && typeof adapter.auth.isValid === 'function'
        ? !!adapter.auth.isValid()
        : true;

      let reason;
      if (!transport.ok) reason = 'transport_unavailable';
      else if (!credentials) reason = 'credentials_missing';

      return result(channel, { adapter: true, transport, credentials }, reason);
    }
  };
}

module.exports = { buildChannelConnectionTester };
