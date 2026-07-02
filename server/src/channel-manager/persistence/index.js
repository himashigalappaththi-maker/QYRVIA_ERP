'use strict';

/**
 * Channel persistence factory (Phase 24 B3 - flag selection + DI).
 *
 * Selects the implementation set per CHANNEL_PERSISTENCE:
 *   memory (default) -> in-memory stores (identical to current runtime behavior)
 *   db               -> DB repos (requires a db with .query; else falls back to memory)
 *   dual             -> writes mirror to db (best-effort), reads/returns from memory
 *
 * Default is 'memory', so constructing this at boot changes NOTHING until the
 * flag is set. No caller is required to consume it (DI only).
 */

const env    = require('../../config/env');
const logger = require('../../config/logger');
const mem    = require('./memoryStores');
const dbm    = require('./dbStores');
const { CONTRACTS } = require('./contracts');

const STORE_KEYS = ['booking', 'mapping', 'queue', 'deadLetter', 'syncState'];

function buildMemorySet() {
  return {
    booking:    mem.buildBookingStoreMemory(),
    mapping:    mem.buildChannelMappingStoreMemory(),
    queue:      mem.buildSyncQueueStoreMemory(),
    deadLetter: mem.buildDeadLetterStoreMemory(),
    syncState:  mem.buildSyncStateStoreMemory()
  };
}

function buildDbSet(db) {
  return {
    booking:    dbm.buildBookingStoreDb({ db }),
    mapping:    dbm.buildChannelMappingStoreDb({ db }),
    queue:      dbm.buildSyncQueueStoreDb({ db }),
    deadLetter: dbm.buildDeadLetterStoreDb({ db }),
    syncState:  dbm.buildSyncStateStoreDb({ db })
  };
}

/**
 * Dual wrapper: every method call mirrors to the db impl (best-effort, errors
 * logged not thrown) and returns the memory impl's result. Memory stays
 * authoritative during the dual stage.
 */
function dualStore(memoryImpl, dbImpl) {
  return new Proxy(memoryImpl, {
    get(target, prop) {
      const fn = target[prop];
      if (typeof fn !== 'function') return fn;
      return (...args) => {
        const dbFn = dbImpl[prop];
        if (typeof dbFn === 'function') {
          try { Promise.resolve(dbFn.apply(dbImpl, args)).catch((err) => logger.warn({ err, op: prop }, '[channelPersistence] dual mirror failed')); }
          catch (err) { logger.warn({ err, op: prop }, '[channelPersistence] dual mirror threw'); }
        }
        return fn.apply(target, args);
      };
    }
  });
}

function buildChannelPersistence({ mode, db } = {}) {
  const requested = mode || env.CHANNEL_PERSISTENCE || 'memory';
  const haveDb = !!(db && typeof db.query === 'function');

  if (requested === 'memory') return Object.assign({ mode: 'memory' }, buildMemorySet());

  if (!haveDb) {
    logger.warn({ requested }, '[channelPersistence] no db client; falling back to memory');
    return Object.assign({ mode: 'memory(fallback)' }, buildMemorySet());
  }

  if (requested === 'db') return Object.assign({ mode: 'db' }, buildDbSet(db));

  if (requested === 'dual') {
    const m = buildMemorySet();
    const d = buildDbSet(db);
    const dual = {};
    for (const k of STORE_KEYS) dual[k] = dualStore(m[k], d[k]);
    return Object.assign({ mode: 'dual' }, dual);
  }

  logger.warn({ requested }, '[channelPersistence] unknown mode; using memory');
  return Object.assign({ mode: 'memory' }, buildMemorySet());
}

module.exports = { buildChannelPersistence, STORE_KEYS, CONTRACTS };
