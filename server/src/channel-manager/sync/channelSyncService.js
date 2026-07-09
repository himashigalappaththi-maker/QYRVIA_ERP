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
 */

function hashRate(r) { return String(r && r.amount) + '|' + String(r && r.currency); }
function hashInv(i) {
  return [String(i && i.available), (i && i.stopSell) ? 1 : 0, String(i && i.minLos), String(i && i.maxLos)].join('|');
}

function buildChannelSyncService({ registry, syncStateStore, realChannels = new Set(['QYRVIA_CONNECT']), clock = () => Date.now(), onAudit } = {}) {
  if (!registry) throw new Error('channelSyncService: registry required');
  if (!syncStateStore) throw new Error('channelSyncService: syncStateStore required');

  function emitAudit(type, meta) { if (typeof onAudit === 'function') { try { onAudit(Object.assign({ type }, meta)); } catch (_) { /* never throws */ } } }
  function isReal(channel) { return realChannels.has(channel); }

  async function _push(kind, { tenant_id, property_id = null, channel, room_type_id, resource, hash, pushFn }) {
    if (!tenant_id || !channel || !room_type_id) return { ok: false, error: 'tenant_channel_room_type_required' };
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

  async function pushRate({ tenant_id, property_id, channel, room_type_id, rate }) {
    return _push('RATE', { tenant_id, property_id, channel, room_type_id, resource: rate || {}, hash: hashRate(rate || {}), pushFn: (a) => a.pushRateUpdate(rate) });
  }
  async function pushAvailability({ tenant_id, property_id, channel, room_type_id, inventory }) {
    return _push('INVENTORY', { tenant_id, property_id, channel, room_type_id, resource: inventory || {}, hash: hashInv(inventory || {}), pushFn: (a) => a.pushAvailability(inventory) });
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
