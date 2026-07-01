# QYRVIA Phase 24 — B8-B1: Secure OTA Credential Store — Validation Report

**Mode:** Implementation (credential domain only). **No OTA network calls, webhooks, worker changes,
UI/frontend, Booking Engine, CRM, Revenue, or AI work.** Default boot is **dormant** (no encryption
key ⇒ no provider).

---

## 1. What was built
1. **`channel_credential_store`** (migration 0047) — RLS-ready, encrypted-at-rest. Secrets live only
   in `encrypted_payload` (JSONB `{ iv, tag, ciphertext }`); **no plaintext column exists**.
2. **SecretProvider** — `get / put / rotate / revoke`. Default **local encrypted** implementation
   (AES-256-GCM via `cryptoBox`); interface is future-compatible with AWS KMS / Azure Key Vault /
   Google Secret Manager (swap the crypto edge, callers unchanged).
3. **AuthStrategy upgrade** — `CredentialAuthStrategy` resolves headers **only** through the
   SecretProvider using a `credentials_ref` + tenant; the secret is fetched on demand and never stored
   on the instance, logged, or returned. Base `AuthStrategy` + `NoopAuthStrategy` unchanged.
4. **Zero plaintext exposure** — verified across persistence, audit events, and the strategy instance.

## 2. Files created
| File | Purpose |
|---|---|
| `db/migrations/0047_channel_credential_store.sql` | Encrypted, RLS-enforced credential table (definition only) |
| `channel-manager/credentials/cryptoBox.js` | AES-256-GCM encrypt/decrypt |
| `channel-manager/credentials/channelCredentialStore.memory.js` | In-memory row CRUD (default) |
| `channel-manager/credentials/channelCredentialStore.db.js` | DB repo (dormant; encrypted UPSERT) |
| `channel-manager/credentials/secretProvider.js` | Local encrypted SecretProvider (get/put/rotate/revoke) |
| `channel-manager/credentials/index.js` | `buildChannelCredentials()` DI factory |
| `test/channelCredentialStore.test.js` | 11 tests |
| `docs/QYRVIA_PHASE24_STEP_B8B1_CREDENTIAL_STORE_REPORT.md` | this report |

## 3. Files modified
| File | Change |
|---|---|
| `adapters/framework/AuthStrategy.js` | Added `CredentialAuthStrategy` + `defaultToHeaders` (base/Noop untouched) |
| `config/env.js` | Added `CHANNEL_CREDENTIAL_KEY` (empty default ⇒ dormant) |
| `index.js` | DI: build `channelCredentials` (no provider unless key set); add to `createApp` deps |

No change to: adapters' public contracts, worker, queue, routes, API, PMS, schema-of-existing-tables,
frontend/UI.

## 4. Migration
- `0047_channel_credential_store.sql` — columns `tenant_id, property_id, channel, credentials_ref,
  credential_type, encrypted_payload (JSONB), key_version, status, created_at, updated_at, rotated_at`;
  `UNIQUE(tenant_id, credentials_ref)`; RLS `ENABLE`+`FORCE` + `app.tenant_id` policy. **Definition
  only** — applied only via `migrate.js up`; the no-DB test suite does not run it.

## 5. Validation
| Check | Result |
|---|---|
| Backend suite (before → after) | **514 / 0 / 3 (517) → 525 / 0 / 3 (528)** (+11, zero regressions) |
| Encryption verified (no plaintext persisted) | ✅ stored row contains ciphertext only; `cryptoBox` round-trips; wrong key fails (GCM auth) |
| Adapters contract-compatible | ✅ bridged adapter with `CredentialAuthStrategy` still passes `validateInterface`; default adapters still `NoopAuthStrategy` |
| AuthStrategy resolves only via SecretProvider | ✅ `getAuthHeaders()` calls `provider.get`; revoked ⇒ `{}`; no secret on instance |
| No frontend / API / UI / OTA-network changes | ✅ |

**Test coverage (11):** crypto round-trip · create+retrieve · rotate (version bump + rotated_at) ·
revoke (get→null, status REVOKED, ciphertext wiped) · **RLS isolation** (cross-tenant read returns
null; tenant_id mandatory) · **no-plaintext-leakage** (store + audit events + strategy instance) ·
AuthStrategy secret resolution (api_key/token/revoked) · adapter compatibility · factory flag
(memory default, provider only with key) · db store encrypted UPSERT SQL · migration validity.

## 6. Zero-plaintext guarantees (how each is enforced)
| Surface | Guarantee |
|---|---|
| Database | Only `encrypted_payload` (ciphertext) is stored; no plaintext column (migration test enforces) |
| Logs | Provider never logs the secret; the plaintext exists only transiently inside `cryptoBox` |
| Events / audit | `onAudit` emits metadata only (`credentials_ref`, `channel`, `key_version`) — verified no secret |
| Queues | Credentials never enter the sync queue; only `credentials_ref` flows; the secret is resolved at the adapter edge |
| Strategy object | `CredentialAuthStrategy` holds `credentials_ref` + provider only; `get()` is the sole plaintext path |

## 7. Risk assessment
| Risk | Level | Mitigation |
|---|:---:|---|
| Runtime behavior change | **NONE** | No key by default ⇒ no provider; store unconsumed; 525/0 |
| Secret leakage | **LOW** | AES-256-GCM at rest; metadata-only audit; no secret on instances/logs/queues; tests assert |
| Key management | MED (future) | `CHANNEL_CREDENTIAL_KEY` is a single app key now; B8-B+/KMS provider replaces it; `key_version` supports rotation |
| RLS in db-mode raw queries | MED (future) | db store dormant; production db-mode must route via `client.withTenant` (B8-B activation note) |
| Migration auto-apply | LOW | Additive table; runs only on explicit `migrate.js up`; tests skip it |

## 8. Rollback plan
- **Instant (config):** leave `CHANNEL_CREDENTIAL_KEY` unset (default) ⇒ provider never created.
- **Code:** delete `channel-manager/credentials/*` and `test/channelCredentialStore.test.js`; revert
  the `AuthStrategy.js` additions, the `env.js` flag, and the three `index.js` DI lines; leave
  migration `0047` unapplied (or drop `channel_credential_store`). Nothing else imports the subsystem.

## 9. Constraints honored
✅ No OTA network calls · ✅ No webhook logic · ✅ No worker changes · ✅ No UI/frontend changes ·
✅ No Booking Engine / CRM / Revenue / AI work · ✅ No API contract changes outside the credential
domain. **UI protection rule:** no UI file touched (N/A).

**STOP after B8-B1.** Awaiting approval for B8-B2 (mapping management).
