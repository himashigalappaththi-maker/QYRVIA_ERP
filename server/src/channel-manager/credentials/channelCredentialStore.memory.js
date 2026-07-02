'use strict';

/**
 * In-memory channel credential store (Phase 24 B8-B1).
 *
 * Raw row CRUD only - NO crypto here (that is the SecretProvider's job). Rows
 * hold `encrypted_payload` exactly as given. Keyed by (tenant_id, credentials_ref)
 * so a different tenant can never read another tenant's row (RLS-equivalent).
 */

const clone = (o) => (o ? Object.assign({}, o) : null);
const matches = (it, filter) => !filter || Object.entries(filter).every(([k, v]) => it[k] === v);

function buildChannelCredentialStoreMemory({ clock = () => Date.now() } = {}) {
  const byKey = new Map();
  const key = (t, ref) => `${t}::${ref}`;

  function put(row) {
    if (!row || !row.tenant_id || !row.credentials_ref) return { accepted: false, reason: 'invalid' };
    const k = key(row.tenant_id, row.credentials_ref);
    const existing = byKey.get(k);
    const now = clock();
    const merged = Object.assign(
      { credential_type: 'API_KEY', key_version: 1, status: 'ACTIVE', property_id: null, channel: null, rotated_at: null, encrypted_payload: {}, created_at: now },
      existing || {}, row, { updated_at: now }
    );
    if (!existing) merged.created_at = now;
    byKey.set(k, merged);
    return { accepted: true, created: !existing, item: clone(merged) };
  }

  function get(tenant_id, credentials_ref) { return clone(byKey.get(key(tenant_id, credentials_ref))); }

  function updatePayload(tenant_id, credentials_ref, patch = {}) {
    const it = byKey.get(key(tenant_id, credentials_ref));
    if (!it) return null;
    if (patch.encrypted_payload !== undefined) it.encrypted_payload = patch.encrypted_payload;
    if (patch.key_version !== undefined) it.key_version = patch.key_version;
    if (patch.rotated_at !== undefined) it.rotated_at = patch.rotated_at;
    if (patch.status !== undefined) it.status = patch.status;
    it.updated_at = clock();
    return clone(it);
  }

  function setStatus(tenant_id, credentials_ref, status) { return updatePayload(tenant_id, credentials_ref, { status }); }
  function list(filter) { const out = []; for (const it of byKey.values()) if (matches(it, filter)) out.push(clone(it)); return out; }
  function clear() { byKey.clear(); }

  return { put, get, updatePayload, setStatus, list, clear };
}

module.exports = { buildChannelCredentialStoreMemory };
