'use strict';

/**
 * SecretProvider (Phase 24 B8-B1).
 *
 * Interface: get(ref) / put(ref, payload) / rotate(ref) / revoke(ref).
 * Default implementation: LOCAL ENCRYPTED - AES-256-GCM (cryptoBox) over the
 * channel credential store. The plaintext secret exists only transiently inside
 * this module; it is never logged, never put on the store except as ciphertext,
 * and only ever leaves via get().
 *
 * Future-compatible: an AWS KMS / Azure Key Vault / Google Secret Manager
 * implementation satisfies the same 4-method interface (swap cryptoBox for the
 * managed service); callers are unaffected.
 */

const { encrypt, decrypt } = require('./cryptoBox');

function buildLocalEncryptedSecretProvider({ store, key, keyVersion = 1, clock = () => Date.now(), onAudit } = {}) {
  if (!store) throw new Error('secretProvider: store required');
  if (!key) throw new Error('secretProvider: encryption key required');

  // Audit emits SAFE metadata only (ref + channel + type + key_version) - NEVER the secret.
  function audit(type, meta) {
    if (typeof onAudit === 'function') { try { onAudit(Object.assign({ type }, meta)); } catch (_) { /* audit never throws */ } }
  }

  return {
    kind: 'local-encrypted',

    async put(credentials_ref, payload, { tenant_id, property_id = null, channel = null, credential_type = 'API_KEY' } = {}) {
      if (!tenant_id || !credentials_ref) throw new Error('secretProvider.put: tenant_id + credentials_ref required');
      const box = encrypt(key, JSON.stringify(payload || {}));
      await store.put({ tenant_id, property_id, channel, credentials_ref, credential_type, encrypted_payload: box, key_version: keyVersion, status: 'ACTIVE' });
      audit('channel.credential_put', { tenant_id, channel, credentials_ref, credential_type, key_version: keyVersion });
      return { credentials_ref, key_version: keyVersion };
    },

    async get(credentials_ref, { tenant_id } = {}) {
      if (!tenant_id) throw new Error('secretProvider.get: tenant_id required');
      const row = await store.get(tenant_id, credentials_ref);
      if (!row || row.status === 'REVOKED' || !row.encrypted_payload || !row.encrypted_payload.ciphertext) return null;
      try { return JSON.parse(decrypt(key, row.encrypted_payload)); } catch (_) { return null; }
    },

    async rotate(credentials_ref, { tenant_id, newPayload, newKeyVersion } = {}) {
      if (!tenant_id) throw new Error('secretProvider.rotate: tenant_id required');
      const row = await store.get(tenant_id, credentials_ref);
      if (!row || row.status === 'REVOKED') return null;
      let payload = newPayload;
      if (payload === undefined) { try { payload = JSON.parse(decrypt(key, row.encrypted_payload)); } catch (_) { payload = {}; } }
      const kv = newKeyVersion != null ? newKeyVersion : (row.key_version || keyVersion) + 1;
      const box = encrypt(key, JSON.stringify(payload || {}));
      const updated = await store.updatePayload(tenant_id, credentials_ref, { encrypted_payload: box, key_version: kv, rotated_at: clock(), status: 'ACTIVE' });
      audit('channel.credential_rotated', { tenant_id, channel: row.channel, credentials_ref, key_version: kv });
      return updated ? { credentials_ref, key_version: kv } : null;
    },

    async revoke(credentials_ref, { tenant_id } = {}) {
      if (!tenant_id) throw new Error('secretProvider.revoke: tenant_id required');
      const row = await store.get(tenant_id, credentials_ref);
      if (!row) return null;
      // Wipe ciphertext + mark revoked so no secret remains recoverable.
      const updated = await store.updatePayload(tenant_id, credentials_ref, { encrypted_payload: {}, status: 'REVOKED', rotated_at: clock() });
      audit('channel.credential_revoked', { tenant_id, channel: row.channel, credentials_ref });
      return updated ? { credentials_ref, status: 'REVOKED' } : null;
    }
  };
}

module.exports = { buildLocalEncryptedSecretProvider };
