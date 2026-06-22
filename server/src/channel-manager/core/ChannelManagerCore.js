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
 */

const { assertImplements } = require('../adapters/base/OTAAdapter');
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
    this._adapters = new Map();
  }

  registerAdapter(adapter) {
    const check = assertImplements(adapter);
    if (!check.ok) throw new Error('registerAdapter: adapter missing ' + check.missing.join(', '));
    this._adapters.set(adapter.channel, adapter);
    return this;
  }

  getAdapter(channel) {
    const a = this._adapters.get(channel);
    if (!a) throw new Error('no adapter registered for channel ' + channel);
    return a;
  }

  listChannels() { return Array.from(this._adapters.keys()); }

  async pushRates(channel, rateFields, ctx) {
    const adapter = this.getAdapter(channel);
    const rate = this.rates.validate(rateFields);
    return this.sync.syncRate(adapter, rate, ctx);
  }

  async pushInventory(channel, invFields, ctx) {
    const adapter = this.getAdapter(channel);
    const inv = this.inventory.validate(invFields);
    return this.sync.syncInventory(adapter, inv, ctx);
  }

  /** Pull raw bookings, normalize, ingest idempotently, emit events. */
  async syncBookings(channel, ctx) {
    const adapter = this.getAdapter(channel);
    const raw = await adapter.pullBookings();
    const summary = { channel, pulled: raw.length, created: 0, deduped: 0, conflicts: [] };
    for (const r of raw) {
      const canonical = adapter.mapToCanonical(r);
      const res = this.bookings.ingest(canonical);
      if (res.action === 'deduped') { summary.deduped += 1; continue; }
      summary.created += 1;
      if (res.conflict) summary.conflicts.push(res.conflict);
      await this.eventBus.emit(events.bookingCreated(canonical), ctx);
    }
    return summary;
  }

  async confirmBooking(channel, bookingId, ctx) {
    const adapter = this.getAdapter(channel);
    await adapter.confirmBooking(bookingId);
    const b = this.bookings.get(bookingId);
    await this.eventBus.emit(events.bookingConfirmed(b || { bookingId, channel }), ctx);
    return { bookingId, channel, status: 'CONFIRMED' };
  }

  async cancelBooking(channel, bookingId, ctx) {
    const adapter = this.getAdapter(channel);
    await adapter.cancelBooking(bookingId);
    const b = this.bookings.get(bookingId);
    await this.eventBus.emit(events.bookingCancelled(b || { bookingId, channel }), ctx);
    return { bookingId, channel, status: 'CANCELLED' };
  }

  status() {
    return {
      channels: this.listChannels().map((c) => {
        const a = this._adapters.get(c);
        return { channel: c, internal: !!a.internal, commissionPct: a.commissionPct != null ? a.commissionPct : null };
      }),
      queue: { size: this.queue.size(), deadLetter: this.queue.deadLetter.length },
      bookings: this.bookings.count()
    };
  }
}

module.exports = { ChannelManagerCore };
