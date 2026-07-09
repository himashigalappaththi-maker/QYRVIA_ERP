'use strict';

/**
 * Channel Manager HTTP controller. Thin: validates request shape, calls
 * ChannelManagerCore, maps the result to a JSON response. Domain events are
 * emitted inside the core (through the shared eventBus -> event_store), so the
 * controller never publishes events directly.
 */

const { errorField } = require('../../middleware/errorEnvelope');
const { buildChannelConnectionTester } = require('../services/channelConnectionTester');
const { reconcile } = require('../ota/reconciliation');

function buildController({ channelManager, deadLetter, credentials, mapping, channelRegistry }) {
  // Phase 37 WI-2b: readiness-only connection tester, built once. It is fail-closed
  // and side-effect-free (no network, no send, no secret resolution).
  const connectionTester = buildChannelConnectionTester({ channelManager });

  function ctxOf(req) { return req.ctx || {}; }

  function fail(res, req, code, status = 400) {
    return res.status(status).json({ ok: false, error: errorField(code), requestId: ctxOf(req).requestId });
  }

  return {
    async syncRates(req, res, next) {
      try {
        const b = req.body || {};
        if (!b.channel) return fail(res, req, 'channel_required');
        const out = await channelManager.pushRates(b.channel, b, ctxOf(req));
        res.json({ ok: true, result: out, requestId: ctxOf(req).requestId });
      } catch (e) { if (/no adapter|Canonical|required/.test(e.message)) return fail(res, req, e.message); next(e); }
    },

    async syncInventory(req, res, next) {
      try {
        const b = req.body || {};
        if (!b.channel) return fail(res, req, 'channel_required');
        const out = await channelManager.pushInventory(b.channel, b, ctxOf(req));
        res.json({ ok: true, result: out, requestId: ctxOf(req).requestId });
      } catch (e) { if (/no adapter|Canonical|required/.test(e.message)) return fail(res, req, e.message); next(e); }
    },

    async syncBookings(req, res, next) {
      try {
        const b = req.body || {};
        if (!b.channel) return fail(res, req, 'channel_required');
        const out = await channelManager.syncBookings(b.channel, ctxOf(req));
        res.json({ ok: true, result: out, requestId: ctxOf(req).requestId });
      } catch (e) { if (/no adapter|not_implemented/.test(e.message)) return fail(res, req, e.message); next(e); }
    },

    async confirmBooking(req, res, next) {
      try {
        const b = req.body || {};
        if (!b.channel || !b.booking_id) return fail(res, req, 'channel_and_booking_id_required');
        const out = await channelManager.confirmBooking(b.channel, b.booking_id, ctxOf(req));
        res.json({ ok: true, result: out, requestId: ctxOf(req).requestId });
      } catch (e) { if (/no adapter|not_implemented/.test(e.message)) return fail(res, req, e.message); next(e); }
    },

    async cancelBooking(req, res, next) {
      try {
        const b = req.body || {};
        if (!b.channel || !b.booking_id) return fail(res, req, 'channel_and_booking_id_required');
        const out = await channelManager.cancelBooking(b.channel, b.booking_id, ctxOf(req));
        res.json({ ok: true, result: out, requestId: ctxOf(req).requestId });
      } catch (e) { if (/no adapter|not_implemented/.test(e.message)) return fail(res, req, e.message); next(e); }
    },

    async testConnection(req, res, next) {
      try {
        // Phase 37 WI-2b: readiness-only diagnostic probe. Uses the READ envelope.
        // The tester is fail-closed (missing tenantId => ready:false) and performs
        // NO network, NO send(), NO secret resolution; ready:false is a valid 200
        // payload (with reason), never an HTTP error.
        const b = req.body || {};
        if (!b.channel) return fail(res, req, 'channel_required');
        const ctx = ctxOf(req);
        const result = await connectionTester.test(b.channel, ctx);
        res.json({ ok: true, data: { ...result, probe: 'readiness_only' }, requestId: ctx.requestId });
      } catch (e) { next(e); }
    },

    async status(req, res, next) {
      try {
        // READ envelope (Phase 23 R1): the single GET emits { ok, data }; sync writes keep { ok, result }.
        res.json({ ok: true, data: channelManager.status(), requestId: ctxOf(req).requestId });
      } catch (e) { next(e); }
    },

    // Phase 37 WI-3: channel operational surfaces (READ envelope). Non-secret,
    // metadata-only; fail-closed on missing tenant. No network, no OTA calls.

    // GET /api/channel/sync-health - core status + tenant-scoped dead-letter count.
    async syncHealth(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        const s = channelManager.status() || {};
        const tenantCount = deadLetter ? (await deadLetter.list({ tenant_id: ctx.tenantId })).length : null;
        res.json({
          ok: true,
          data: {
            channels: s.channels,
            queue: s.queue,
            bookings: s.bookings,
            deadLetters: { tenantCount }
          },
          requestId: ctx.requestId
        });
      } catch (e) { next(e); }
    },

    // GET /api/channel/dlq - tenant-scoped dead-letter metadata (NO payload_json).
    async dlqList(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        if (!deadLetter) return res.json({ ok: true, data: { items: [] }, requestId: ctx.requestId });
        const rows = await deadLetter.list({ tenant_id: ctx.tenantId });
        const items = (rows || []).map((r) => ({
          id: r.id,
          channel: r.channel,
          action: r.action,
          reservation_id: r.reservation_id,
          attempts: r.attempts,
          last_error: r.last_error,
          reprocess_requested: r.reprocess_requested,
          created_at: r.created_at,
          updated_at: r.updated_at
        }));
        res.json({ ok: true, data: { items }, requestId: ctx.requestId });
      } catch (e) { next(e); }
    },

    // POST /api/channel/dlq/reprocess - flags reprocess_requested (NO network, NO OTA).
    async dlqReprocess(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        const id = (req.body || {}).id;
        if (!id) return fail(res, req, 'id_required');
        if (!deadLetter) return fail(res, req, 'dlq_unavailable', 400);
        // Ownership guard: never reveal cross-tenant existence.
        const rec = await deadLetter.get(id);
        if (!rec || rec.tenant_id !== ctx.tenantId) return fail(res, req, 'dead_letter_not_found', 404);
        const out = await deadLetter.requestReprocess(id);
        res.json({ ok: true, result: { id: out.id, reprocess_requested: out.reprocess_requested }, requestId: ctx.requestId });
      } catch (e) { next(e); }
    },

    // Phase 40: channel credential + mapping management. Credentials are WRITE-ONLY -
    // status returns safe metadata only (configured flag, ref, type, timestamps),
    // NEVER the encrypted_payload/secret. Fail-closed on missing tenant.

    // GET /api/channel/credentials/status - safe, non-secret credential status per tenant.
    async credentialsStatus(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        const store = credentials && credentials.store;
        if (!store) return res.json({ ok: true, data: { available: false, items: [] }, requestId: ctx.requestId });
        const rows = await Promise.resolve(store.list({ tenant_id: ctx.tenantId }));
        // SAFE projection only - encrypted_payload / secret is NEVER included.
        const items = (rows || []).map((r) => ({
          channel: r.channel,
          credentials_ref: r.credentials_ref,
          credential_type: r.credential_type,
          key_version: r.key_version,
          status: r.status,
          configured: true,
          created_at: r.created_at,
          updated_at: r.updated_at
        }));
        res.json({ ok: true, data: { available: true, items }, requestId: ctx.requestId });
      } catch (e) { next(e); }
    },

    // POST /api/channel/credentials - store a credential ENCRYPTED via the provider.
    // The secret payload is used transiently and NEVER returned or logged.
    async credentialsSave(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        const b = req.body || {};
        if (!b.channel || !b.credentials_ref || !b.payload || typeof b.payload !== 'object') {
          return fail(res, req, 'channel_credentials_required');
        }
        const provider = credentials && credentials.provider;
        if (!provider || typeof provider.put !== 'function') return fail(res, req, 'credentials_provider_unavailable', 400);
        await provider.put(b.credentials_ref, b.payload, {
          tenant_id: ctx.tenantId, channel: b.channel, credential_type: b.credential_type || 'API_KEY'
        });
        // Phase 50: advance registry status not_configured -> configured (credential evidence).
        // Never promotes to live; never downgrades live/sandbox/paused.
        if (channelRegistry) {
          try {
            const reg = await channelRegistry.get(b.channel, { tenantId: ctx.tenantId, propertyId: ctx.propertyId || null });
            if (reg && reg.status === 'not_configured') {
              await channelRegistry.setStatus(b.channel, 'configured', { tenantId: ctx.tenantId, propertyId: ctx.propertyId || null });
            }
          } catch (_) { /* registry bridge failure never blocks credential save */ }
        }
        // Return only a non-secret acknowledgement.
        res.json({ ok: true, result: { channel: b.channel, credentials_ref: b.credentials_ref, configured: true }, requestId: ctx.requestId });
      } catch (e) { next(e); }
    },

    // GET /api/channel/mappings - safe operational mapping metadata per tenant.
    async mappingsList(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        const svc = mapping && mapping.service;
        if (!svc || typeof svc.listMappings !== 'function') return res.json({ ok: true, data: { available: false, items: [] }, requestId: ctx.requestId });
        const rows = await Promise.resolve(svc.listMappings({ tenant_id: ctx.tenantId }));
        const items = (rows || []).map((m) => ({
          channel: m.channel,
          room_type_id: m.room_type_id,
          ota_room_id: m.ota_room_id,
          ota_rate_plan_id: m.ota_rate_plan_id,
          enabled: m.enabled,
          mapping_version: m.mapping_version
        }));
        res.json({ ok: true, data: { available: true, items }, requestId: ctx.requestId });
      } catch (e) { next(e); }
    },

    // POST /api/channel/mappings - upsert a room/rate mapping (safe metadata only).
    async mappingsSave(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        const b = req.body || {};
        if (!b.channel || !b.room_type_id) return fail(res, req, 'channel_room_type_required');
        const svc = mapping && mapping.service;
        if (!svc || typeof svc.upsertMapping !== 'function') return fail(res, req, 'mapping_unavailable', 400);
        const out = svc.upsertMapping({
          tenant_id: ctx.tenantId, channel: b.channel, room_type_id: b.room_type_id,
          ota_room_id: b.ota_room_id != null ? b.ota_room_id : null,
          ota_rate_plan_id: b.ota_rate_plan_id != null ? b.ota_rate_plan_id : null
        }, { actor_id: ctx.actorId });
        if (!out || out.ok === false) return fail(res, req, (out && out.error) || 'mapping_failed');
        res.json({ ok: true, result: { channel: b.channel, room_type_id: b.room_type_id, mapping_version: out.mapping_version, change_type: out.change_type }, requestId: ctx.requestId });
      } catch (e) { next(e); }
    },

    // Phase 49 - channel registry handlers.
    // All registry ops are fail-closed on missing tenant and missing channelRegistry.

    async registryList(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        if (!channelRegistry) return res.json({ ok: true, data: { items: [] }, requestId: ctx.requestId });
        const items = await channelRegistry.list({ tenantId: ctx.tenantId, propertyId: ctx.propertyId });
        res.json({ ok: true, data: { items }, requestId: ctx.requestId });
      } catch (e) { next(e); }
    },

    async registryAdd(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        if (!channelRegistry) return fail(res, req, 'channel_registry_unavailable', 400);
        const b = req.body || {};
        if (!b.channel_code) return fail(res, req, 'channel_code_required');
        const row = await channelRegistry.add(b, { tenantId: ctx.tenantId, propertyId: ctx.propertyId });
        res.status(201).json({ ok: true, data: row, requestId: ctx.requestId });
      } catch (e) { next(e); }
    },

    async registryGet(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        if (!channelRegistry) return fail(res, req, 'channel_registry_unavailable', 400);
        const row = await channelRegistry.get(req.params.channel, { tenantId: ctx.tenantId, propertyId: ctx.propertyId });
        if (!row) return fail(res, req, 'channel_not_found', 404);
        res.json({ ok: true, data: row, requestId: ctx.requestId });
      } catch (e) { next(e); }
    },

    async registrySetStatus(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        if (!channelRegistry) return fail(res, req, 'channel_registry_unavailable', 400);
        const { status } = req.body || {};
        if (!status) return fail(res, req, 'status_required');
        const row = await channelRegistry.setStatus(req.params.channel, status,
          { tenantId: ctx.tenantId, propertyId: ctx.propertyId });
        res.json({ ok: true, data: row, requestId: ctx.requestId });
      } catch (e) {
        if (/invalid_status|channel_not_found/.test(e.message)) return fail(res, req, e.message, /channel_not_found/.test(e.message) ? 404 : 400);
        next(e);
      }
    },

    async registryToggle(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        if (!channelRegistry) return fail(res, req, 'channel_registry_unavailable', 400);
        const row = await channelRegistry.toggle(req.params.channel,
          { tenantId: ctx.tenantId, propertyId: ctx.propertyId });
        res.json({ ok: true, data: row, requestId: ctx.requestId });
      } catch (e) {
        if (/channel_not_found/.test(e.message)) return fail(res, req, e.message, 404);
        next(e);
      }
    },

    async registryRecordError(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        if (!channelRegistry) return fail(res, req, 'channel_registry_unavailable', 400);
        const { error } = req.body || {};
        if (!error) return fail(res, req, 'error_required');
        const row = await channelRegistry.recordError(req.params.channel, error,
          { tenantId: ctx.tenantId, propertyId: ctx.propertyId });
        res.json({ ok: true, data: row, requestId: ctx.requestId });
      } catch (e) { next(e); }
    },

    async registryRecordSync(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        if (!channelRegistry) return fail(res, req, 'channel_registry_unavailable', 400);
        const row = await channelRegistry.recordSync(req.params.channel,
          { tenantId: ctx.tenantId, propertyId: ctx.propertyId });
        res.json({ ok: true, data: row, requestId: ctx.requestId });
      } catch (e) { next(e); }
    },

    // Phase 50 - POST /api/channel/reconciliation
    // Pure drift computation: accepts local + remote snapshots, returns recommendations.
    // No OTA network call. Uses channel.sync.read permission (read-only computation).
    async reconciliation(req, res, next) {
      try {
        const ctx = ctxOf(req);
        if (!ctx.tenantId) return fail(res, req, 'tenant_required', 401);
        const b = req.body || {};
        if (!b.channel) return fail(res, req, 'channel_required');
        const report = reconcile({
          channel: String(b.channel).toUpperCase(),
          local:   b.local  || {},
          remote:  b.remote || {}
        });
        res.json({ ok: true, data: report, requestId: ctx.requestId });
      } catch (e) { next(e); }
    }
  };
}

module.exports = { buildController };
