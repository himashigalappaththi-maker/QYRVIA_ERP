'use strict';

/**
 * ChannelManagerCore - the orchestration layer.
 *
 * Responsibilities:
 *   - Adapter registry (register / lookup / list).
 *   - Canonical transformation pipeline (raw -> canonical via the adapter).
 *   - Sync orchestration (delegates to SyncEngine -> QueueManager; the core
 *     never calls an OTA directly).
 *   - Event emission hooks (through ChannelEventBus -> event_store).
 *   - Conflict-resolution gateway (BookingService + ConflictResolver).
 *
 * Construct with no args for sensible in-process defaults, or inject doubles
 * in tests.
 *
 * --------------------------------------------------------------------------
 * Phase 28 - Channel Manager Core migration to the canonical adapter registry.
 *
 * The core is now backed by the unified canonical adapter registry
 * (adapters/framework/adapterRegistry) instead of an ad-hoc Map keyed on the
 * legacy 6-method contract. This makes the canonical framework the SINGLE source
 * of truth for adapters across the whole system (the same registry the outbound
 * sync already uses), and lets canonical-native adapters (e.g. TransportOTAAdapter
 * for real OTAs) live in the same core as the bridged mocks.
 *
 * Compatibility (behavior-preserving):
 *   - registerAdapter() accepts BOTH a canonical adapter and a legacy 6-method
 *     adapter; a legacy adapter is auto-bridged via bridgeLegacyAdapter().
 *   - Orchestration resolves a legacy-shaped "ops" view (_ops) for each channel:
 *       * bridged legacy adapter -> its original ._legacy surface (identical behavior)
 *       * pure-canonical adapter -> a synthesized surface mapping the canonical
 *         methods (pushRateUpdate / pushAvailability / pushReservation /
 *         normalizeBooking) onto the orchestration calls.
 *     This keeps SyncEngine and the service layer untouched.
 *   - Booking-ingestion compatibility: syncBookings() is a PULL operation. Legacy
 *     mocks expose pullBookings(); canonical-native ingestion is webhook-driven, so
 *     a pure-canonical adapter pulls nothing here (raw=[]) and ingests via the
 *     inbound webhook pipeline instead. See the Phase 28 report.
 *
 * Rollback: CHANNEL_CANONICAL_CORE=false (or { canonicalRegistry:false }) restores
 * the legacy Map registry path below. No code is removed.
 */

const env = require('../../config/env');
const { assertImplements } = require('../adapters/base/OTAAdapter');
const { buildAdapterRegistry } = require('../adapters/framework/adapterRegistry');
const { validateInterface } = require('../adapters/framework/adapterValidator');
const { bridgeLegacyAdapter } = require('../adapters/framework/legacyBridge');
const { ChannelEventBus } = require('./events/ChannelEventBus');
const { QueueManager } = require('./sync/QueueManager');
const { SyncEngine } = require('./sync/SyncEngine');
const { buildRateService } = require('../services/RateService');
const { buildInventoryService } = require('../services/InventoryService');
const { buildBookingService } = require('../services/BookingService');
const events = require('./events/events');

class ChannelManagerCore {
  constructor(deps = {}) {
    this.eventBus = deps.eventBus || new ChannelEventBus();
    this.queue = deps.queue || new QueueManager({ rateLimits: deps.rateLimits || {} });
    this.sync = deps.syncEngine || new SyncEngine({ queue: this.queue, eventBus: this.eventBus });
    this.rates = deps.rateService || buildRateService();
    this.inventory = deps.inventoryService || buildInventoryService();
    this.bookings = deps.bookingService || buildBookingService();

    // Phase 28: canonical registry is the source of truth; legacy Map retained for rollback.
    this._canonical = deps.canonicalRegistry != null
      ? !!deps.canonicalRegistry
      : (env.CHANNEL_CANONICAL_CORE !== 'false');
    this._registry = this._canonical ? buildAdapterRegistry() : null;
    this._adapters = this._canonical ? null : new Map();
  }

  registerAdapter(adapter) {
    if (this._canonical) {
      let canonical = adapter;
      if (!validateInterface(adapter).ok) {
        // Not a canonical adapter - require the legacy contract, then bridge it.
        const legacy = assertImplements(adapter);
        if (!legacy.ok) throw new Error('registerAdapter: adapter missing ' + legacy.missing.join(', '));
        canonical = bridgeLegacyAdapter(adapter);
      }
      this._registry.register(canonical);
      return this;
    }
    // Legacy rollback path: ad-hoc Map on the 6-method contract.
    const check = assertImplements(adapter);
    if (!check.ok) throw new Error('registerAdapter: adapter missing ' + check.missing.join(', '));
    this._adapters.set(adapter.channel, adapter);
    return this;
  }

  getAdapter(channel) {
    if (this._canonical) {
      if (!this._registry.has(channel)) throw new Error('no adapter registered for channel ' + channel);
      return this._registry.get(channel);
    }
    const a = this._adapters.get(channel);
    if (!a) throw new Error('no adapter registered for channel ' + channel);
    return a;
  }

  listChannels() { return this._canonical ? this._registry.list() : Array.from(this._adapters.keys()); }

  /**
   * Resolve the legacy-shaped operations used by the orchestration, regardless of
   * registry mode. Behavior-preserving: a bridged legacy adapter delegates to its
   * original surface; a pure-canonical adapter is adapted onto the canonical methods.
   */
  _ops(channel) {
    const a = this.getAdapter(channel);
    if (!this._canonical) return a;        // legacy adapter already has the 6-method surface
    if (a._legacy) return a._legacy;       // bridged legacy -> original surface (identical behavior)
    // Pure-canonical adapter -> synthesize the orchestration surface.
    return {
      channel: a.channel,
      internal: a.internal,
      commissionPct: a.commissionPct,
      pushRates: (r) => a.pushRateUpdate(r),
      pushInventory: (i) => a.pushAvailability(i),
      pullBookings: async () => [],        // canonical ingestion is webhook-driven (no pull)
      confirmBooking: (id) => a.pushReservation({ bookingId: id, status: 'CONFIRMED' }),
      cancelBooking: (id) => a.pushReservation({ bookingId: id, status: 'CANCELLED' }),
      mapToCanonical: (raw) => a.normalizeBooking(raw)
    };
  }

  async pushRates(channel, rateFields, ctx) {
    const ops = this._ops(channel);
    const rate = this.rates.validate(rateFields);
    return this.sync.syncRate(ops, rate, ctx);
  }

  async pushInventory(channel, invFields, ctx) {
    const ops = this._ops(channel);
    const inv = this.inventory.validate(invFields);
    return this.sync.syncInventory(ops, inv, ctx);
  }

  /** Pull raw bookings, normalize, ingest idempotently, emit events. */
  async syncBookings(channel, ctx) {
    const ops = this._ops(channel);
    const raw = await ops.pullBookings();
    const summary = { channel, pulled: raw.length, created: 0, deduped: 0, conflicts: [] };
    for (const r of raw) {
      const canonical = ops.mapToCanonical(r);
      const res = this.bookings.ingest(canonical);
      if (res.action === 'deduped') { summary.deduped += 1; continue; }
      summary.created += 1;
      if (res.conflict) summary.conflicts.push(res.conflict);
      await this.eventBus.emit(events.bookingCreated(canonical), ctx);
    }
    return summary;
  }

  async confirmBooking(channel, bookingId, ctx) {
    const ops = this._ops(channel);
    await ops.confirmBooking(bookingId);
    const b = this.bookings.get(bookingId);
    await this.eventBus.emit(events.bookingConfirmed(b || { bookingId, channel }), ctx);
    return { bookingId, channel, status: 'CONFIRMED' };
  }

  async cancelBooking(channel, bookingId, ctx) {
    const ops = this._ops(channel);
    await ops.cancelBooking(bookingId);
    const b = this.bookings.get(bookingId);
    await this.eventBus.emit(events.bookingCancelled(b || { bookingId, channel }), ctx);
    return { bookingId, channel, status: 'CANCELLED' };
  }

  status() {
    return {
      channels: this.listChannels().map((c) => {
        const ops = this._ops(c);
        return { channel: c, internal: !!ops.internal, commissionPct: ops.commissionPct != null ? ops.commissionPct : null };
      }),
      queue: { size: this.queue.size(), deadLetter: this.queue.deadLetter.length },
      bookings: this.bookings.count()
    };
  }
}

module.exports = { ChannelManagerCore };
