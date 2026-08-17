'use strict';

/**
 * Phase 69B (instruction 050) — secure Booking.com TEST machine-account
 * onboarding. Reusable core logic only — no TTY, no CLI argv parsing (that
 * lives in server/scripts/channel/bookingComTestAccountOnboardingCli.js),
 * no key generation (server/scripts/channel/generateChannelCredentialKey.js).
 *
 * ZERO NETWORK. This module never imports fetch/http/https/axios and never
 * contacts Booking.com or any provider — it only plans and (when explicitly
 * invoked by a FUTURE authorized caller) writes LOCAL encrypted
 * configuration through QYRVIA's EXISTING credential/registry/mapping
 * services. configureBookingComTestAccount() is implemented and unit-tested
 * here but is NEVER called against real infrastructure by this instruction
 * (instruction 050 Section 15: "implement and unit-test it, but DO NOT
 * execute that mode in this instruction").
 *
 * ARCHITECTURE — nothing here is Booking.com-only by construction
 * (instruction 050 Section 22 commercial multi-channel compatibility
 * review): credential storage goes through the EXISTING generic
 * SecretProvider (put/get/rotate/revoke — the same 4-method interface every
 * other provider's credentials already use); connection status goes through
 * the EXISTING generic channelRegistryService (get/setStatus — the same
 * 'sandbox'/'live' enum every channel already has); mapping goes through
 * the EXISTING generic channelMappingService (upsertMapping — the same
 * versioned/audited store every channel already uses). The ONLY
 * Booking.com-specific piece is the credential object's field NAMES
 * (client_id/client_secret/environment) and the room-id integer validation
 * this module reuses from providers/bookingcom.js — widening this file to
 * a second provider later is a parameter/config change, not an
 * architecture rewrite.
 *
 * SECRET SAFETY (instruction 050 Section 5): this module NEVER logs,
 * returns, or embeds a client_secret/JWT/Authorization value in any thrown
 * error, plan object, or preflight result. Every function below is
 * independently proven redaction-safe by
 * test/phase69b_bookingcom_test_account_onboarding.test.js.
 */

const { CHANNELS } = require('../../core/canonical/types');
const { isValidBookingComRoomId } = require('../../ota/providers/bookingcom');

const CHANNEL = CHANNELS.BOOKING_COM;
const TARGET_OPERATION = 'AVAILABILITY_INVENTORY_PUSH'; // matches testPropertyGuard.js's PERMITTED_TEST_OPERATIONS
const CREDENTIAL_TYPE = 'OAUTH2'; // existing channel_credential_store enum value (migration 0047) — token-exchange credentials, not API_KEY/BASIC

function onboardingError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

/**
 * Builds the EXACT credential object contract instruction 049's token
 * provider expects — {client_id, client_secret, environment:'TEST'} — and
 * nothing else (instruction 050 Section 9: "Do not invent additional
 * required Booking.com secret fields unless CURRENT code requires them").
 * Validates presence/shape WITHOUT ever including the secret value in a
 * thrown error message.
 */
function buildTestCredentialPayload({ clientId, clientSecret } = {}) {
  if (typeof clientId !== 'string' || clientId.trim().length === 0) {
    throw onboardingError('BOOKING_COM_ONBOARDING_MISSING_CLIENT_ID', 'client_id is required and must be a non-empty string');
  }
  if (typeof clientSecret !== 'string' || clientSecret.length === 0) {
    // Deliberately never interpolates clientSecret's value into this message.
    throw onboardingError('BOOKING_COM_ONBOARDING_MISSING_CLIENT_SECRET', 'client_secret is required and must be a non-empty string');
  }
  return Object.freeze({ client_id: clientId, client_secret: clientSecret, environment: 'TEST' });
}

/**
 * Production-safety refusal guard (instruction 050 Section 17). Hard
 * refusal (never a warning) on any of the listed conditions. Pure function
 * — no DB, no network. Distinct from (but consistent with)
 * testPropertyGuard.js's assertBookingComTestOperationAllowed(): THAT guard
 * proves a REAL provider operation may run once a real token exists; THIS
 * guard proves a LOCAL CONFIGURATION WRITE is safe to plan/execute before
 * any token has ever been obtained (no network occurred yet to obtain one).
 *
 * @param {object} input
 * @param {string} input.targetChannel                   must be exactly 'BOOKING_COM'
 * @param {string} input.requestedConnectionStatus        must be exactly 'sandbox'
 * @param {string} input.mappingClassification             must be exactly 'TEST' (never 'PRODUCTION')
 * @param {string} input.credentialEnvironment             must be exactly 'TEST'
 * @param {string|null} [input.existingRegistryStatus]     current channel_registry.status, if any row already exists
 * @param {string} input.tenantId
 * @param {string} input.propertyId
 * @param {string} input.mappingTenantId
 * @param {string} input.mappingPropertyId
 * @param {string} input.credentialsRef                    the ref this onboarding is configuring
 * @param {string} input.mappingCredentialsRef              the ref the mapping plan would bind to (must equal credentialsRef)
 * @param {string} input.bookingComRoomId                   must pass isValidBookingComRoomId()
 * @param {object} [input.liveGates]                        { [gateName]: boolean }
 * @param {boolean} [input.networkExecutionRequested]       must be falsy
 * @returns {{allowed:boolean, reason:string|null}}
 */
function assertBookingComOnboardingSafe(input = {}) {
  const {
    targetChannel = null, requestedConnectionStatus = null, mappingClassification = null,
    credentialEnvironment = null, existingRegistryStatus = null,
    tenantId = null, propertyId = null, mappingTenantId = null, mappingPropertyId = null,
    credentialsRef = null, mappingCredentialsRef = null, bookingComRoomId = null,
    liveGates = {}, networkExecutionRequested = false
  } = input;

  if (targetChannel !== CHANNEL) {
    return { allowed: false, reason: 'TARGET_CHANNEL_NOT_BOOKING_COM' };
  }
  if (requestedConnectionStatus !== 'sandbox') {
    return { allowed: false, reason: 'ONBOARDING_MUST_REQUEST_SANDBOX_ONLY' };
  }
  if (mappingClassification !== 'TEST') {
    return { allowed: false, reason: 'MAPPING_NOT_CLASSIFIED_TEST' };
  }
  if (credentialEnvironment !== 'TEST') {
    return { allowed: false, reason: 'CREDENTIAL_NOT_TEST_CLASSIFIED' };
  }
  if (existingRegistryStatus === 'live') {
    return { allowed: false, reason: 'REFUSED_WOULD_DOWNGRADE_LIVE_REGISTRY' };
  }
  if (!tenantId || !propertyId || tenantId !== mappingTenantId || propertyId !== mappingPropertyId) {
    return { allowed: false, reason: 'TENANT_PROPERTY_MISMATCH' };
  }
  if (!credentialsRef || !mappingCredentialsRef || credentialsRef !== mappingCredentialsRef) {
    return { allowed: false, reason: 'CREDENTIALS_REF_MISMATCH' };
  }
  if (!bookingComRoomId || !isValidBookingComRoomId(bookingComRoomId)) {
    return { allowed: false, reason: 'INVALID_BOOKING_COM_ROOM_ID' };
  }
  const activeLiveGate = Object.keys(liveGates || {}).find((k) => liveGates[k] === true);
  if (activeLiveGate) {
    return { allowed: false, reason: 'PROVIDER_LIVE_MODE_SELECTED:' + activeLiveGate };
  }
  if (networkExecutionRequested) {
    return { allowed: false, reason: 'NETWORK_EXECUTION_NOT_AUTHORIZED_FOR_ONBOARDING' };
  }
  return { allowed: true, reason: null };
}

/**
 * Pure, deterministic "what would happen" plan — NO I/O, NO secret values
 * embedded (only credentialsRef, a pointer, never the secret it points to).
 * Same input always yields the identical plan (instruction 050 Section 16
 * idempotency proof at the planning layer).
 */
function planOnboarding(input = {}) {
  const guard = assertBookingComOnboardingSafe(input);
  if (!guard.allowed) return { ok: false, blocked: true, reason: guard.reason };

  return {
    ok: true,
    blocked: false,
    steps: [
      {
        step: 'STORE_CREDENTIAL',
        description: 'Encrypt and store {client_id, client_secret, environment:TEST} via the existing SecretProvider.put(), credential_type=' + CREDENTIAL_TYPE,
        credentialsRef: input.credentialsRef,
        channel: CHANNEL,
        tenantId: input.tenantId
      },
      {
        step: 'SET_REGISTRY_SANDBOX',
        description: 'channelRegistry.setStatus(BOOKING_COM, "sandbox", ctx) — never promotes to live, refused above if the existing row is already live',
        tenantId: input.tenantId,
        propertyId: input.propertyId
      },
      {
        step: 'BIND_TEST_MAPPING',
        description: 'mappingService.upsertMapping({..., ota_property_id, ota_room_id, credentials_ref}) — binds the mapping to the SAME credential configured above',
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        roomTypeId: input.roomTypeId,
        bookingComTestPropertyId: input.bookingComTestPropertyId,
        bookingComRoomId: input.bookingComRoomId,
        credentialsRef: input.credentialsRef
      }
    ],
    operation: TARGET_OPERATION,
    note: 'This is a PLAN only — configureBookingComTestAccount() performs these writes; this instruction never calls it against real infrastructure.'
  };
}

/**
 * WRITE MODE. Implemented and unit-tested (with injected fake deps) but
 * NEVER invoked against real infrastructure by this instruction (instruction
 * 050 Section 15). Sequential, individually-idempotent writes through
 * EXISTING service APIs only — no ad-hoc SQL, no second credential store,
 * no plaintext secret persistence, no schema mutation, no broad UPDATE/
 * DELETE, no DROP/TRUNCATE, no superuser/BYPASSRLS.
 *
 * NOT a single ACID database transaction: the three underlying services
 * (SecretProvider, channelRegistryService, channelMappingService) are
 * separate, independently-DI'd concerns in this codebase today, each with
 * its own store construction — there is no existing composed
 * "all three under one transaction" API to call, and building one would be
 * a materially larger change than this instruction's narrow authorization
 * covers. This is DISCLOSED, not hidden: safety instead comes from each
 * step being independently IDEMPOTENT (re-running the whole flow after a
 * partial failure converges to the same end state — proven in
 * test/phase69b_bookingcom_test_account_onboarding.test.js's idempotency
 * tests), which is this instruction's actual coherence requirement
 * (Section 16), satisfied without inventing a cross-service transaction
 * this codebase does not yet have.
 *
 * @param {object} deps
 * @param {{put:Function}} deps.secretProvider
 * @param {{get:Function, setStatus:Function}} deps.channelRegistry
 * @param {{upsertMapping:Function}} deps.mappingService
 * @param {Function} [deps.onAudit]   SAFE metadata only — see emitAudit() below.
 * @param {Function} [deps.clock]
 * @param {object} input   same shape as assertBookingComOnboardingSafe()'s input, PLUS:
 * @param {{clientId:string, clientSecret:string}} input.credential
 * @returns {Promise<{ok:boolean, blocked:boolean, reason?:string, steps?:object[]}>}
 */
async function configureBookingComTestAccount({ deps = {}, input = {} } = {}) {
  const { secretProvider, channelRegistry, mappingService, onAudit, clock = () => Date.now() } = deps;

  const guard = assertBookingComOnboardingSafe(input);
  if (!guard.allowed) return { ok: false, blocked: true, reason: guard.reason };

  if (!secretProvider || typeof secretProvider.put !== 'function') {
    throw onboardingError('BOOKING_COM_ONBOARDING_SECRET_PROVIDER_UNAVAILABLE', 'secretProvider.put is required — configuration cannot proceed without the existing encrypted credential store');
  }
  if (!channelRegistry || typeof channelRegistry.get !== 'function' || typeof channelRegistry.setStatus !== 'function') {
    throw onboardingError('BOOKING_COM_ONBOARDING_REGISTRY_UNAVAILABLE', 'channelRegistry.get/setStatus are required');
  }
  if (!mappingService || typeof mappingService.upsertMapping !== 'function') {
    throw onboardingError('BOOKING_COM_ONBOARDING_MAPPING_SERVICE_UNAVAILABLE', 'mappingService.upsertMapping is required');
  }

  function audit(type, meta) {
    if (typeof onAudit === 'function') { try { onAudit(Object.assign({ type, at: clock() }, meta)); } catch (_) { /* audit never blocks/throws */ } }
  }

  // Fresh, uncached registry re-check FIRST — BEFORE any write at all
  // (mirrors ariChannelDispatcher.js's own "fresh per call, never cached"
  // discipline). A live promotion that happened between planning and
  // execution must block EVERY subsequent step, including credential
  // storage — writing a TEST credential under an already-live connection's
  // (tenant, property, BOOKING_COM) row is itself the risk this refusal
  // exists to prevent, not merely the registry-status write.
  const currentReg = await channelRegistry.get(CHANNEL, { tenantId: input.tenantId, propertyId: input.propertyId });
  if (currentReg && currentReg.status === 'live') {
    audit('channel.test_onboarding_refused_live_registry', { tenant_id: input.tenantId, channel: CHANNEL });
    return { ok: false, blocked: true, reason: 'REFUSED_WOULD_DOWNGRADE_LIVE_REGISTRY' };
  }

  const payload = buildTestCredentialPayload({ clientId: input.credential && input.credential.clientId, clientSecret: input.credential && input.credential.clientSecret });

  // Step 1 — encrypted credential storage (existing SecretProvider only).
  await secretProvider.put(input.credentialsRef, payload, {
    tenant_id: input.tenantId, property_id: input.propertyId || null,
    channel: CHANNEL, credential_type: CREDENTIAL_TYPE
  });
  audit('channel.test_onboarding_credential_stored', {
    tenant_id: input.tenantId, channel: CHANNEL, credentials_ref: input.credentialsRef, environment: 'TEST'
  });

  // Step 2 — registry sandbox status (already proven safe above).
  await channelRegistry.setStatus(CHANNEL, 'sandbox', { tenantId: input.tenantId, propertyId: input.propertyId });
  audit('channel.test_onboarding_registry_sandbox_set', { tenant_id: input.tenantId, channel: CHANNEL, environment: 'TEST' });

  // Step 3 — TEST property/room mapping, bound to the SAME credential.
  await mappingService.upsertMapping({
    tenant_id: input.tenantId, property_id: input.propertyId, channel: CHANNEL,
    room_type_id: input.roomTypeId, ota_property_id: input.bookingComTestPropertyId,
    ota_room_id: input.bookingComRoomId, credentials_ref: input.credentialsRef, enabled: true
  });
  audit('channel.test_onboarding_mapping_bound', {
    tenant_id: input.tenantId, channel: CHANNEL, credentials_ref: input.credentialsRef, operation: TARGET_OPERATION
  });

  return { ok: true, blocked: false, steps: ['STORE_CREDENTIAL', 'SET_REGISTRY_SANDBOX', 'BIND_TEST_MAPPING'] };
}

/**
 * Boolean-only operator preflight (instruction 050 Section 14). NEVER
 * returns a secret value, encrypted payload, token, or Authorization
 * header — every field is a presence/status boolean.
 *
 * @param {object} deps  { channelCredentials:{store}, channelRegistry, mappingService }
 * @param {object} args  { tenantId, propertyId, roomTypeId, credentialsRef }
 */
async function computeOnboardingPreflight({ deps = {}, args = {} } = {}) {
  const { channelCredentialsStore, channelRegistry, mappingService } = deps;
  const { tenantId, propertyId, roomTypeId, credentialsRef } = args;

  const out = {
    CHANNEL_CREDENTIAL_KEY_PRESENT: !!deps.channelCredentialKeyPresent,
    BOOKING_COM_TEST_CREDENTIAL_REF_PRESENT: false,
    BOOKING_COM_CHANNEL_REGISTRY_SANDBOX_READY: false,
    BOOKING_COM_TEST_MAPPING_PRESENT: false,
    BOOKING_COM_MAPPING_CREDENTIAL_REF_MATCH: false,
    BOOKING_COM_TEST_ROOM_ID_VALID: false,
    BOOKING_COM_TEST_PROPERTY_ID_PRESENT: false,
    BOOKING_COM_LIVE_GATES_ALL_FALSE: !!deps.liveGatesAllFalse,
    BOOKING_COM_DRY_RUN_CODEC_READY: true // buildAvailabilityXml/testPropertyGuard modules are always present in this codebase — a static, code-level fact, not an infra probe
  };

  if (!tenantId || !propertyId) return out;

  if (channelCredentialsStore && credentialsRef) {
    try {
      const row = await channelCredentialsStore.get(tenantId, credentialsRef);
      out.BOOKING_COM_TEST_CREDENTIAL_REF_PRESENT = !!(row && row.status !== 'REVOKED');
    } catch (_) { /* presence check only — never throws past this boundary */ }
  }

  if (channelRegistry) {
    try {
      const reg = await channelRegistry.get(CHANNEL, { tenantId, propertyId });
      out.BOOKING_COM_CHANNEL_REGISTRY_SANDBOX_READY = !!(reg && reg.status === 'sandbox');
    } catch (_) { /* presence check only */ }
  }

  let mappingRow = null;
  if (mappingService && roomTypeId) {
    try {
      mappingRow = await mappingService.getMapping(tenantId, propertyId, CHANNEL, roomTypeId);
      out.BOOKING_COM_TEST_MAPPING_PRESENT = !!mappingRow;
      out.BOOKING_COM_MAPPING_CREDENTIAL_REF_MATCH = !!(mappingRow && credentialsRef && mappingRow.credentials_ref === credentialsRef);
      out.BOOKING_COM_TEST_ROOM_ID_VALID = !!(mappingRow && isValidBookingComRoomId(mappingRow.ota_room_id));
      out.BOOKING_COM_TEST_PROPERTY_ID_PRESENT = !!(mappingRow && mappingRow.ota_property_id);
    } catch (_) { /* presence check only */ }
  }

  return out;
}

module.exports = {
  buildTestCredentialPayload,
  assertBookingComOnboardingSafe,
  planOnboarding,
  configureBookingComTestAccount,
  computeOnboardingPreflight,
  TARGET_OPERATION,
  CREDENTIAL_TYPE
};
