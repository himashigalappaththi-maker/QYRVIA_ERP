'use strict';

/**
 * Abstract AuthStrategy (Phase 24 B8-A).
 *
 * CORE RULE: the core never handles secrets. An adapter receives only a
 * `credentials_ref` - an opaque pointer to a secret resolved at the edge by a
 * future secret provider. Concrete strategies (API key, OAuth2 client-credentials,
 * signed-HMAC) live behind this boundary; nothing above the adapter sees a secret.
 */

class AuthStrategy {
  constructor({ credentialsRef = null } = {}) {
    this.credentialsRef = credentialsRef; // opaque reference, NOT a secret value
  }
  async getAuthHeaders() { return {}; }   // resolved from credentialsRef at the edge (future)
  async refresh() { return { refreshed: false }; }
  isValid() { return true; }
}

/** No-op strategy for mock adapters: no auth, no secrets. */
class NoopAuthStrategy extends AuthStrategy {}

/** Default mapping of a resolved secret payload -> request headers. */
function defaultToHeaders(secret) {
  if (!secret || typeof secret !== 'object') return {};
  if (secret.api_key) return { 'X-Api-Key': secret.api_key };
  if (secret.token) return { Authorization: 'Bearer ' + secret.token };
  if (secret.username && secret.password) return { Authorization: 'Basic ' + Buffer.from(secret.username + ':' + secret.password).toString('base64') };
  return {};
}

/**
 * Credential-backed strategy (Phase 24 B8-B1). The core hands the adapter only a
 * `credentialsRef` (+ tenant) and a SecretProvider; the secret is resolved
 * ON DEMAND inside getAuthHeaders() and is NEVER stored on this instance, logged,
 * or returned. This is how an adapter consumes credentials without the core ever
 * seeing a secret.
 */
class CredentialAuthStrategy extends AuthStrategy {
  constructor({ credentialsRef, tenantId, secretProvider, toHeaders } = {}) {
    super({ credentialsRef });
    this._tenantId = tenantId || null;
    this._provider = secretProvider || null;     // resolver, not the secret
    this._toHeaders = typeof toHeaders === 'function' ? toHeaders : defaultToHeaders;
  }
  async getAuthHeaders() {
    if (!this._provider || !this.credentialsRef) return {};
    const secret = await this._provider.get(this.credentialsRef, { tenant_id: this._tenantId });
    if (!secret) return {};
    return this._toHeaders(secret) || {};   // secret used transiently; not retained
  }
  isValid() { return !!(this._provider && this.credentialsRef); }
}

module.exports = { AuthStrategy, NoopAuthStrategy, CredentialAuthStrategy, defaultToHeaders };
