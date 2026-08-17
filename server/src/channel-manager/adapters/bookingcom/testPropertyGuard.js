'use strict';

/**
 * Phase 69A (instruction 048) — Booking.com TEST-property safety guard.
 *
 * A future one-shot Booking.com sandbox harness (server/scripts/channel/) must
 * refuse to run unless ALL of the following are explicitly, structurally
 * proven — never inferred, never guessed from an ID's shape (instruction 048
 * Section 17: "Do not guess whether a numeric Booking.com property ID is
 * test or production. QYRVIA must store/know this classification
 * explicitly."):
 *
 *   1. connection environment = TEST
 *        -> channel_registry.status === 'sandbox' for (tenant, property,
 *           BOOKING_COM). 'sandbox' is an EXISTING, pre-Phase-69A enum value
 *           on channel_registry (migration 0055_channel_registry.sql) — no
 *           schema change. See instruction 048 Section 18's own
 *           "prefer existing metadata/config structures" requirement.
 *   2. credential reference explicitly marked/associated with TEST
 *        -> the resolved secret payload's own `environment` field (set at
 *           credential-put time, inside the already-encrypted payload —
 *           channel_credential_store.encrypted_payload is arbitrary JSON,
 *           no schema change) equals 'TEST'.
 *   3. mapped Booking.com property is explicitly identified as a
 *      test-property mapping in QYRVIA configuration
 *        -> channel_mapping_store's own `credentials_ref` column (EXISTING
 *           since migration 0045_channel_persistence.sql, previously
 *           unused by the ARI dispatch path) is set AND equals the SAME
 *           credentialsRef being used for this attempt — i.e. the mapping
 *           is structurally bound to the specific (TEST-classified, per
 *           check 2) credential, not merely co-located with it.
 *   4. operation = permitted one-shot test operation
 *        -> exactly one of PERMITTED_TEST_OPERATIONS.
 *   5. provider live/production mode is NOT selected
 *        -> none of the caller-supplied live-gate booleans read true.
 *
 * Pure function — no DB, no network, no filesystem. Fully unit-testable with
 * plain objects, per instruction 048 Section 17's own requirement.
 */

const PERMITTED_TEST_OPERATIONS = Object.freeze(['AVAILABILITY_INVENTORY_PUSH']);

/**
 * @param {object} input
 * @param {string} [input.connectionStatus]       channel_registry.status for this (tenant, property, BOOKING_COM)
 * @param {string} [input.credentialEnvironment]  the resolved secret payload's `environment` field
 * @param {string|null} [input.mappingCredentialsRef]   channel_mapping_store row's own credentials_ref
 * @param {string} [input.resolvedCredentialsRef]  the credentialsRef actually authorizing this attempt
 * @param {string} [input.operation]               requested one-shot operation
 * @param {object} [input.liveGates]               { [gateName]: boolean } — e.g. { ariBookingComLive, ariOutboxDispatchEnabled }
 * @returns {{allowed:boolean, reason:string|null}}
 */
function assertBookingComTestOperationAllowed({
  connectionStatus = null,
  credentialEnvironment = null,
  mappingCredentialsRef = null,
  resolvedCredentialsRef = null,
  operation = null,
  liveGates = {}
} = {}) {
  if (connectionStatus !== 'sandbox') {
    return { allowed: false, reason: 'CONNECTION_ENVIRONMENT_NOT_TEST' };
  }
  if (credentialEnvironment !== 'TEST') {
    return { allowed: false, reason: 'CREDENTIAL_NOT_TEST_CLASSIFIED' };
  }
  if (!mappingCredentialsRef) {
    return { allowed: false, reason: 'MAPPING_MISSING_CREDENTIALS_REF' };
  }
  if (!resolvedCredentialsRef || mappingCredentialsRef !== resolvedCredentialsRef) {
    return { allowed: false, reason: 'MAPPING_CREDENTIALS_REF_MISMATCH' };
  }
  if (!PERMITTED_TEST_OPERATIONS.includes(operation)) {
    return { allowed: false, reason: 'OPERATION_NOT_PERMITTED_FOR_TEST' };
  }
  const activeLiveGate = Object.keys(liveGates || {}).find((k) => liveGates[k] === true);
  if (activeLiveGate) {
    return { allowed: false, reason: 'PROVIDER_LIVE_MODE_SELECTED:' + activeLiveGate };
  }
  return { allowed: true, reason: null };
}

module.exports = { assertBookingComTestOperationAllowed, PERMITTED_TEST_OPERATIONS };
