'use strict';

/**
 * SyncEngine - delta-aware orchestration over the QueueManager.
 *
 * The core NEVER calls an OTA directly: it asks the SyncEngine, which builds an
 * idempotent job and hands it to the queue. The engine keeps a per-resource
 * delta hash so unchanged rates/inventory are skipped (delta sync, not full
 * resync loops). On success it emits a channel event; on terminal failure it
 * emits `channel.sync_failed` (partial-failure isolation is the queue's job).
 */

const { rateKey } = require('../canonical/CanonicalRate');
const { inventoryKey } = require('../canonical/CanonicalInventory');
const events = require('../events/events');

function hashRate(r) { return r.amount + '|' + r.currency; }
function hashInv(i) { return i.available + '|' + (i.stopSell ? 1 : 0) + '|' + i.minLos + '|' + i.maxLos; }

class SyncEngine {
  constructor({ queue, eventBus }) {
    if (!queue) throw new Error('SyncEngine: queue required');
    if (!eventBus) throw new Error('SyncEngine: eventBus required');
    this._queue = queue;
    this._events = eventBus;
    this._delta = new Map();   // resourceKey -> last applied hash
  }

  /** Skip if the resource value is unchanged since last successful push. */
  _isDelta(key, hash) {
    return this._delta.get(key) !== hash;
  }

  async syncRate(adapter, rate, ctx) {
    const key = rateKey(rate);
    const hash = hashRate(rate);
    if (!this._isDelta(key, hash)) return { skipped: true, reason: 'no_delta', key };

    this._queue.enqueue({
      channel: adapter.channel, idempotencyKey: key + '#' + hash,
      run: async () => {
        await adapter.pushRates(rate);
        this._delta.set(key, hash);
        await this._events.emit(events.rateUpdated(adapter.channel, rate), ctx);
        return { key };
      }
    });
    const [res] = await this._queue.process();
    if (res && !res.ok) await this._events.emit(events.syncFailed(adapter.channel, 'pushRates', res.error), ctx);
    return res || { skipped: true };
  }

  async syncInventory(adapter, inv, ctx) {
    const key = inventoryKey(inv);
    const hash = hashInv(inv);
    if (!this._isDelta(key, hash)) return { skipped: true, reason: 'no_delta', key };

    this._queue.enqueue({
      channel: adapter.channel, idempotencyKey: key + '#' + hash,
      run: async () => {
        await adapter.pushInventory(inv);
        this._delta.set(key, hash);
        await this._events.emit(events.inventoryUpdated(adapter.channel, inv), ctx);
        return { key };
      }
    });
    const [res] = await this._queue.process();
    if (res && !res.ok) await this._events.emit(events.syncFailed(adapter.channel, 'pushInventory', res.error), ctx);
    return res || { skipped: true };
  }
}

module.exports = { SyncEngine };
