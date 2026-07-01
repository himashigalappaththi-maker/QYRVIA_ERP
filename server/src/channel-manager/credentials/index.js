'use strict';

/**
 * Channel credentials factory (Phase 24 B8-B1) - DI entry point.
 *
 * Returns { store, provider, mode, hasProvider }. The store honors
 * CHANNEL_PERSISTENCE (memory default); the SecretProvider is created only when
 * an encryption key (CHANNEL_CREDENTIAL_KEY) is available. Default boot has no
 * key => no provider => fully dormant, no behavior change.
 */

const env = require('../../config/env');
const logger = require('../../config/logger');
const { buildChannelCredentialStoreMemory } = require('./channelCredentialStore.memory');
const { buildChannelCredentialStoreDb } = require('./channelCredentialStore.db');
const { buildLocalEncryptedSecretProvider } = require('./secretProvider');

function buildChannelCredentials({ mode, db, key, onAudit } = {}) {
  const resolved = mode || env.CHANNEL_PERSISTENCE || 'memory';
  const haveDb = !!(db && typeof db.query === 'function');
  const store = (resolved !== 'memory' && haveDb)
    ? buildChannelCredentialStoreDb({ db })
    : buildChannelCredentialStoreMemory();

  const encKey = key || env.CHANNEL_CREDENTIAL_KEY || null;
  let provider = null;
  if (encKey) {
    try { provider = buildLocalEncryptedSecretProvider({ store, key: encKey, onAudit }); }
    catch (e) { logger.warn({ err: e }, '[channelCredentials] provider init failed'); }
  }
  return { store, provider, mode: resolved, hasProvider: !!provider };
}

module.exports = {
  buildChannelCredentials,
  buildChannelCredentialStoreMemory,
  buildChannelCredentialStoreDb,
  buildLocalEncryptedSecretProvider
};
