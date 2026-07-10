'use strict';

const { DEFAULT_CHANNELS } = require('./defaultChannels');

const VALID_STATUSES = new Set(['not_configured', 'configured', 'sandbox', 'live', 'error', 'paused']);

/**
 * Phase 49 — channel registry service.
 *
 * Business rules:
 *   - On first list() for a tenant/property the 8 default channels are seeded.
 *   - QYRVIA_CONNECT seeds as enabled=true, status='live' (QYRVIA-owned B2B OTA/distribution platform).
 *   - All others seed as enabled=false, status='not_configured'.
 *   - 'live' status may only be set via setStatus() — never auto-promoted.
 *   - toggle() flips enabled; if disabling a 'live' channel, status → 'paused'.
 *   - recordError() sets status='error' and persists the error message.
 *   - recordSync() clears last_error and updates last_sync_at.
 */
function buildChannelRegistryService({ repo }) {
  if (!repo) throw new Error('channelRegistryService: repo required');

  async function _seed(ctx) {
    await Promise.all(DEFAULT_CHANNELS.map(ch => repo.seed({
      tenant_id:     ctx.tenantId,
      property_id:   ctx.propertyId || null,
      channel_code:  ch.code,
      display_name:  ch.name,
      enabled:       ch.qyrvia_owned,
      status:        ch.qyrvia_owned ? 'live' : 'not_configured',
      commission_pct: ch.commissionPct,
    })));
  }

  async function _ensureSeeded(ctx) {
    const rows = await repo.list(ctx);
    if (rows.length === 0) await _seed(ctx);
  }

  async function list(ctx) {
    await _ensureSeeded(ctx);
    return repo.list(ctx);
  }

  async function get(channelCode, ctx) {
    await _ensureSeeded(ctx);
    return repo.findByCode(channelCode.toUpperCase(), ctx);
  }

  async function add(body, ctx) {
    if (!body.channel_code) throw new Error('channel_code required');
    const code = String(body.channel_code).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    return repo.upsert({
      tenant_id:     ctx.tenantId,
      property_id:   ctx.propertyId || null,
      channel_code:  code,
      display_name:  body.display_name || code,
      commission_pct: body.commission_pct ?? null,
      enabled:       false,
      status:        'not_configured',
    });
  }

  async function setStatus(channelCode, status, ctx) {
    if (!VALID_STATUSES.has(status)) {
      throw new Error('invalid_status: must be one of ' + Array.from(VALID_STATUSES).join(', '));
    }
    await _ensureSeeded(ctx);
    const row = await repo.updateFields(channelCode.toUpperCase(), { status }, ctx);
    if (!row) throw new Error('channel_not_found');
    return row;
  }

  async function toggle(channelCode, ctx) {
    await _ensureSeeded(ctx);
    const current = await repo.findByCode(channelCode.toUpperCase(), ctx);
    if (!current) throw new Error('channel_not_found');
    // Snapshot before toggle — in-memory repos mutate the row in place
    const wasEnabled = current.enabled;
    const wasStatus  = current.status;
    const row = await repo.toggle(channelCode.toUpperCase(), ctx);
    // If disabling a live channel → mark paused
    if (row && wasEnabled && wasStatus === 'live') {
      return repo.updateFields(channelCode.toUpperCase(), { status: 'paused' }, ctx);
    }
    return row;
  }

  async function recordError(channelCode, error, ctx) {
    return repo.updateFields(channelCode.toUpperCase(),
      { status: 'error', last_error: String(error).slice(0, 2000) }, ctx);
  }

  async function recordSync(channelCode, ctx) {
    return repo.updateFields(channelCode.toUpperCase(),
      { last_sync_at: new Date().toISOString(), last_error: null }, ctx);
  }

  // Phase 53 Fix 4: emergency kill switch — sets enabled=false, status=paused,
  // and records kill_switch_at/by/reason. Distinct from toggle(); reason is required.
  async function kill(channelCode, reason, ctx) {
    if (!reason || !String(reason).trim()) throw new Error('kill_switch_reason_required');
    await _ensureSeeded(ctx);
    const row = await repo.updateFields(channelCode.toUpperCase(), {
      enabled: false,
      status: 'paused',
      kill_switch_at: new Date().toISOString(),
      kill_switch_by: ctx.userId || ctx.actorId || null,
      kill_switch_reason: String(reason).trim().slice(0, 1000),
    }, ctx);
    if (!row) throw new Error('channel_not_found');
    return row;
  }

  return { list, get, add, setStatus, toggle, recordError, recordSync, kill };
}

module.exports = { buildChannelRegistryService };
