'use strict';

/**
 * channelSyncService (Phase 24 B8-B3) - outbound availability/rate sync.
 *
 * For each push: delta-check against sync_state_store (skip unchanged), deliver
 * via the channel's canonical adapter ONLY if the channel is enabled for real
 * sync (per-channel flag), then record sync state + a SAFE audit event. Channels
 * not flagged real are a no-op (no delivery), so nothing external is touched.
 *
 * No webhooks, no PMS writes, no worker changes - outbound push only.
 *
 * PHASE 68A — MANUAL/AUTOMATIC ARI DOUBLE-SEND GUARD (instruction 032 Section 17)
 * ─────────────────────────────────────────────────────────────────────────────
 * Instruction 031's audit named this service's pushRate()/pushAvailability()
 * (reachable today only via channel.controller.js's admin-triggered POST
 * routes — grep-confirmed those are its only live callers) as an independent,
 * MANUAL outbound path for the exact same rate/availability data the new
 * src/ari/dispatch/ariChannelDispatcher.js delivers AUTOMATICALLY once its
 * live gates are ever flipped true. Two independent delivery paths for the
 * same commercial write, with no shared coordination, is a P0 double-send
 * risk the moment BOTH could be active at once.
 *
 * This service does not (and, without a much larger redesign that instruction
 * 032 does not authorize, cannot) share the durable per-channel ledger
 * ariChannelDispatcher.js uses — a manual push has no ari_outbox_store row to
 * key a ledger entry on. The guard implemented here is therefore a NARROWER,
 * honest one: a manual push to a channel this phase's automatic ARI
 * dispatcher is capable of ALSO delivering to (today: BOOKING_COM) is
 * REFUSED by default the moment automatic ARI dispatch is actually capable of
 * running (isAriAutoDispatchLive() — true only when BOTH
 * ARI_OUTBOX_DISPATCH_ENABLED and ARI_BOOKING_COM_LIVE read 'true', the exact
 * same condition that gates ariChannelDispatcher.isReady()). The caller must
 * then explicitly pass `forceResync: true` to proceed — an operator's
 * deliberate, disclosed decision (FORCE_RESYNC semantics), never an implicit
 * default. With every live gate false (this instruction's entire scope, and
 * every existing caller/test today), isAriAutoDispatchLive() is always false,
 * so this guard is a documented no-op and changes NO existing behavior.
 */

function hashRate(r) { return String(r && r.amount) + '|' + String(r && r.currency); }
function hashInv(i) {
  return [String(i && i.available), (i && i.stopSell) ? 1 : 0, String(i && i.minLos), String(i && i.maxLos)].join('|');
}

/** True only when automatic ARI dispatch is actually capable of running for
 * ANY channel — mirrors ariChannelDispatcher.isReady()'s own gate condition
 * exactly (minus per-instance dependency wiring, which this service cannot
 * see). Injectable for tests; defaults to reading the real env gates. */
function defaultIsAriAutoDispatchLive() {
  const env = require('../../config/env');
  return env.ARI_OUTBOX_DISPATCH_ENABLED === 'true' && env.ARI_BOOKING_COM_LIVE === 'true';
}

// Channels the automatic ARI dispatcher can ALSO deliver to today — mirrors
// ariChannelDispatcher.js's SUPPORTED_EXTERNAL_CHANNELS plus QYRVIA_CONNECT
// (which the dispatcher always attempts once ready). Kept as its own literal
// list rather than importing ariChannelDispatcher (which would pull the
// entire ARI dispatch module into every channelSyncService construction,
// including boots that never touch ARI at all) — both lists are reviewed
// together whenever either changes.
const ARI_AUTO_DISPATCH_CAPABLE_CHANNELS = new Set(['BOOKING_COM', 'QYRVIA_CONNECT']);

function buildChannelSyncService({
  registry, syncStateStore, realChannels = new Set(['QYRVIA_CONNECT']), clock = () => Date.now(),
  onAudit, channelRegistry = null, isAriAutoDispatchLive = defaultIsAriAutoDispatchLive
} = {}) {
  if (!registry) throw new Error('channelSyncService: registry required');
  if (!syncStateStore) throw new Error('channelSyncService: syncStateStore required');

  function emitAudit(type, meta) { if (typeof onAudit === 'function') { try { onAudit(Object.assign({ type }, meta)); } catch (_) { /* never throws */ } } }
  function isReal(channel) { return realChannels.has(channel); }

  async function _push(kind, { tenant_id, property_id = null, channel, room_type_id, resource, hash, pushFn, ctx = {} }) {
    if (!tenant_id || !channel || !room_type_id) return { ok: false, error: 'tenant_channel_room_type_required' };

    // H2: Kill-switch — check channel registry before pushing
    if (channelRegistry) {
      const reg = await channelRegistry.get(channel, { tenantId: tenant_id, propertyId: property_id, ...ctx }).catch(() => null);
      if (reg && !reg.enabled) {
        return { ok: false, error: 'channel_disabled', skipped: true };
      }
    }

    // Phase 68A double-send guard (see module header). Only RATE/INVENTORY
    // kinds overlap the ARI dispatcher's domain — pushReservation() never
    // routes through _push() and is unaffected.
    if (ARI_AUTO_DISPATCH_CAPABLE_CHANNELS.has(channel) && !ctx.forceResync) {
      let autoLive = false;
      try { autoLive = !!isAriAutoDispatchLive(); } catch (_) { autoLive = false; }
      if (autoLive) {
        return { ok: false, error: 'ari_auto_dispatch_active_requires_force_resync', skipped: true };
      }
    }

    const resource_key = `${channel}|${kind}|${room_type_id}|${(resource && resource.date) || ''}`;

    const existing = await Promise.resolve(syncStateStore.get(tenant_id, channel, resource_key));
    if (existing && existing.last_hash === hash) {
      return { ok: true, skipped: true, reason: 'no_delta', resource_key };
    }

    let ack = { ok: true, mocked: true };          // non-real channel => no delivery
    const real = isReal(channel);
    if (real) {
      const adapter = registry.get(channel);       // throws on unknown channel
      ack = await pushFn(adapter);
    }

    await Promise.resolve(syncStateStore.upsert({
      tenant_id, property_id, channel, resource_key, room_type_id,
      last_hash: hash, last_status: ack && ack.ok ? 'OK' : 'FAILED', last_sync_at: clock()
    }));
    emitAudit('channel.' + kind.toLowerCase() + '_pushed', { tenant_id, channel, room_type_id, resource_key, real, status: ack && ack.ok ? 'OK' : 'FAILED' });
    return { ok: !!(ack && ack.ok), skipped: false, real, resource_key };
  }

  async function pushRate({ tenant_id, property_id, channel, room_type_id, rate, forceResync = false }) {
    return _push('RATE', { tenant_id, property_id, channel, room_type_id, resource: rate || {}, hash: hashRate(rate || {}), pushFn: (a) => a.pushRateUpdate(rate), ctx: { forceResync } });
  }
  async function pushAvailability({ tenant_id, property_id, channel, room_type_id, inventory, forceResync = false }) {
    return _push('INVENTORY', { tenant_id, property_id, channel, room_type_id, resource: inventory || {}, hash: hashInv(inventory || {}), pushFn: (a) => a.pushAvailability(inventory), ctx: { forceResync } });
  }

  // Outbound reservation push (full bi-directional). Delivered only for real channels.
  async function pushReservation({ tenant_id, property_id, channel, reservation }) {
    const rid = reservation && (reservation.bookingId || reservation.reservation_id || reservation.id);
    if (!tenant_id || !channel || !rid) return { ok: false, error: 'tenant_channel_reservation_required' };
    const real = isReal(channel);
    let ack = { ok: true, mocked: true };
    if (real) ack = await registry.get(channel).pushReservation(reservation);
    const resource_key = `${channel}|RESERVATION|${rid}`;
    await Promise.resolve(syncStateStore.upsert({
      tenant_id, property_id, channel, resource_key, reservation_id: String(rid),
      last_hash: String((reservation && reservation.status) || ''), last_status: ack && ack.ok ? 'OK' : 'FAILED', last_sync_at: clock()
    }));
    emitAudit('channel.reservation_pushed', { tenant_id, channel, reservation_id: String(rid), real, status: ack && ack.ok ? 'OK' : 'FAILED' });
    return { ok: !!(ack && ack.ok), real, resource_key };
  }

  return { pushRate, pushAvailability, pushReservation, isReal };
}

module.exports = { buildChannelSyncService, hashRate, hashInv };
