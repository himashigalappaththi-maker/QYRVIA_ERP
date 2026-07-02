'use strict';

/**
 * Channel mapping management factory (Phase 24 B8-B2) - DI entry point.
 *
 * Wires the mapping store (reused from the persistence layer) + an append-only
 * history store + the versioning/audit service. Honors CHANNEL_PERSISTENCE
 * (memory default). Additive + dormant: no caller is required to consume it.
 */

const env = require('../../config/env');
const memStores = require('../persistence/memoryStores');
const dbStores = require('../persistence/dbStores');
const { buildChannelMappingHistoryStoreMemory } = require('./channelMappingHistoryStore.memory');
const { buildChannelMappingHistoryStoreDb } = require('./channelMappingHistoryStore.db');
const { buildChannelMappingService } = require('./channelMappingService');

function buildChannelMappingManagement({ mode, db, mappingStore, onAudit } = {}) {
  const resolved = mode || env.CHANNEL_PERSISTENCE || 'memory';
  const haveDb = !!(db && typeof db.query === 'function');

  const mStore = mappingStore || (resolved !== 'memory' && haveDb
    ? dbStores.buildChannelMappingStoreDb({ db })
    : memStores.buildChannelMappingStoreMemory());

  const hStore = (resolved !== 'memory' && haveDb)
    ? buildChannelMappingHistoryStoreDb({ db })
    : buildChannelMappingHistoryStoreMemory();

  const service = buildChannelMappingService({ mappingStore: mStore, historyStore: hStore, onAudit });
  return { service, mappingStore: mStore, historyStore: hStore, mode: resolved };
}

module.exports = { buildChannelMappingManagement };
