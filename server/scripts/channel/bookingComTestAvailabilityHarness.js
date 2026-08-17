'use strict';

/**
 * Phase 69A (instruction 048 Section 24) — Booking.com TEST-property
 * one-shot availability harness. DRY-RUN / PREFLIGHT ONLY in this phase.
 *
 * THIS FILE NEVER MAKES A NETWORK CALL. `runDryRun()` builds and returns the
 * exact request QYRVIA WOULD send (endpoint, headers, XML body) and proves
 * every safety precondition holds, but never calls an HTTP transport's
 * send() — there is no code path in this file that can reach one, by
 * construction (no `http`/`fetch` dependency is imported or accepted at
 * all). A future, separately-authorized instruction is required to add an
 * actual network-sending capability; passing `networkAuthorized: true` to
 * runDryRun() today is explicitly, unconditionally REFUSED (see
 * NETWORK_NOT_YET_AUTHORIZED below) — there is no flag, env var, or
 * parameter in this file that can make it send a real request in this
 * phase.
 *
 * Safety properties (instruction 048 Section 24), each satisfied by
 * construction, not by convention:
 *   - manual invocation only        -> plain CLI entry point below (require.main
 *                                       guard); nothing in this file registers a
 *                                       timer, cron, or worker loop.
 *   - no scheduler / no worker poll -> no setInterval/setTimeout anywhere in
 *                                       this file; runDryRun() runs once and returns.
 *   - explicit TEST environment,
 *     exact TEST credential ref,
 *     exact tenant/property/room
 *     mapping, refuses production-
 *     classified mapping, refuses
 *     missing test classification  -> delegates to the SAME
 *                                       assertBookingComTestOperationAllowed()
 *                                       guard the rest of Phase 69A uses — no
 *                                       parallel/duplicate safety logic to
 *                                       drift out of sync.
 *   - availability/inventory only  -> the only operation this file builds is
 *                                       AVAILABILITY_INVENTORY_PUSH; the guard
 *                                       itself refuses any other operation string.
 *   - exactly ONE delivery attempt
 *     maximum                       -> runDryRun() is a single async function
 *                                       call with no internal loop or retry.
 *   - reuses normal durable ledger  -> the request preview documents (not
 *                                       executes) the SAME ensureDeliveryForTenant/
 *                                       claimForTenant/markCompleted state
 *                                       machine a live send would use — no
 *                                       parallel bookkeeping is invented. No
 *                                       ledger ROW is written by a dry run
 *                                       (see `ledgerWriteExecutedInThisRun: false`).
 *   - deterministic correlation ID -> derived from the caller-supplied
 *                                       identifiers alone, never
 *                                       Math.random()/Date.now().
 *   - no secret logging /
 *     no Authorization logging     -> this file never resolves a secret or a
 *                                       token at all — dry-run mode has no
 *                                       reason to touch SecretProvider or the
 *                                       token provider, so there is nothing
 *                                       to log in the first place.
 *   - bounded response logging     -> moot in this phase (no response is ever
 *                                       received — no network call is made).
 *   - refuses HTTP (non-TLS)       -> the only endpoint this file ever
 *                                       resolves is bookingcom.endpointFor(),
 *                                       which is always the documented HTTPS
 *                                       Connectivity host.
 *   - no default credentials /
 *     no default property          -> every identity field (tenantId,
 *                                       propertyId, roomTypeId, credentialsRef)
 *                                       is REQUIRED with no fallback value.
 *   - dry-run/preflight mode is
 *     the default                  -> there is no way to make this file do
 *                                       anything OTHER than a dry run in this
 *                                       phase.
 *   - network execution requires a
 *     FUTURE explicit authorization
 *     mechanism                     -> see NETWORK_NOT_YET_AUTHORIZED.
 */

const { mapInventoryChanged } = require('../../src/ari/dispatch/ariRateMapping');
const { bookingcom, buildAvailabilityXml } = require('../../src/channel-manager/ota/providers/bookingcom');
const { assertBookingComTestOperationAllowed, PERMITTED_TEST_OPERATIONS } = require('../../src/channel-manager/adapters/bookingcom/testPropertyGuard');

const OPERATION = 'AVAILABILITY_INVENTORY_PUSH';

function harnessError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

/**
 * Deterministic correlation id — built ONLY from caller-supplied identifiers,
 * never from Math.random()/Date.now()/new Date() (this repo's standing
 * convention for anything that must be reproducible across runs/reviews).
 */
function buildCorrelationId({ credentialsRef, tenantId, propertyId, roomTypeId, date }) {
  return ['bcth', credentialsRef, tenantId, propertyId, roomTypeId, date].join(':').slice(0, 200);
}

/**
 * @param {object} input
 * @param {string} input.tenantId          REQUIRED — no default.
 * @param {string} input.propertyId        REQUIRED — no default.
 * @param {string} input.roomTypeId        REQUIRED — no default.
 * @param {string} input.credentialsRef    REQUIRED — the credential this run claims authorizes it. No default.
 * @param {string} input.connectionStatus  channel_registry.status for (tenant, property, BOOKING_COM) — operator-supplied, this file performs no DB read.
 * @param {string} input.credentialEnvironment  the resolved credential's own `environment` field ('TEST' expected) — operator-supplied.
 * @param {{otaPropertyId:string, otaRoomId:string, credentialsRef:string}} input.mapping
 *        the channel_mapping_store row's relevant fields, INCLUDING its own credentials_ref
 *        (must match input.credentialsRef — see testPropertyGuard.js).
 * @param {{date:string, physical:number, sold:number, blocked?:number, stopSell?:boolean}} input.inventory
 *        the SAME authoritative shape ariRateMapping.js's mapInventoryChanged already requires — no fabricated defaults.
 * @param {boolean} [input.networkAuthorized]  if true, this run is UNCONDITIONALLY refused in this phase (see header).
 * @param {object}  [input.liveGates]  test/operator override for the real env-gate
 *        read below — e.g. { ariBookingComLive: true } — never used by the plain
 *        CLI entry point, which always reads the REAL env (config/env.js caches
 *        process.env at first require, exactly like every other gate read in
 *        this codebase — this override exists so callers/tests can prove the
 *        refusal behavior without needing to control process.env at module-load
 *        time).
 * @returns {Promise<{ok:boolean, blocked:boolean, reason?:string, preflight?:object}>}
 */
async function runDryRun(input = {}) {
  const {
    tenantId, propertyId, roomTypeId, credentialsRef,
    connectionStatus, credentialEnvironment, mapping, inventory,
    networkAuthorized = false, liveGates: liveGatesOverride
  } = input;

  // No default credentials, no default property, no default tenant/room —
  // every identity field must be explicitly supplied.
  if (!tenantId || !propertyId || !roomTypeId || !credentialsRef) {
    return { ok: false, blocked: true, reason: 'MISSING_REQUIRED_IDENTIFIER' };
  }

  const env = require('../../src/config/env');
  const guard = assertBookingComTestOperationAllowed({
    connectionStatus,
    credentialEnvironment,
    mappingCredentialsRef: mapping && mapping.credentialsRef,
    resolvedCredentialsRef: credentialsRef,
    operation: OPERATION,
    liveGates: liveGatesOverride || {
      ariBookingComLive: env.ARI_BOOKING_COM_LIVE === 'true',
      ariOutboxDispatchEnabled: env.ARI_OUTBOX_DISPATCH_ENABLED === 'true',
      ariOutboxWorkerEnabled: env.ARI_OUTBOX_WORKER_ENABLED === 'true',
      ariOutboxHttpEnabled: env.ARI_OUTBOX_HTTP_ENABLED === 'true',
      channelHttpEnabled: env.CHANNEL_HTTP_ENABLED === 'true'
    }
  });
  if (!guard.allowed) {
    return { ok: false, blocked: true, reason: guard.reason };
  }

  // Build the REAL mapped input + REAL XML body through the exact same
  // production codec the live dispatcher uses — no shortcut, no simplified
  // "test version" of the mapping/serialization logic.
  let mapped, xml;
  try {
    mapped = mapInventoryChanged(
      { payload: inventory || {} },
      { otaPropertyId: mapping && mapping.otaPropertyId, otaRoomId: mapping && mapping.otaRoomId }
    );
    xml = buildAvailabilityXml(mapped.input);
  } catch (e) {
    return { ok: false, blocked: true, reason: (e && e.code) || 'ARI_MAPPING_OR_XML_BUILD_FAILED' };
  }

  const correlationId = buildCorrelationId({ credentialsRef, tenantId, propertyId, roomTypeId, date: mapped.input.date });
  const endpoint = bookingcom.endpointFor('pushAvailability', {});
  const headers = Object.assign(
    { 'X-Qyrvia-Correlation-Id': correlationId },
    bookingcom.headersFor('pushAvailability')
    // Deliberately NO Authorization header here — dry-run mode never
    // resolves a secret or a token, so there is nothing to redact and
    // nothing that could ever be logged.
  );

  // Unconditional refusal — see file header. No parameter, flag, or
  // combination of inputs can make this function proceed past this point.
  if (networkAuthorized === true) {
    throw harnessError(
      'NETWORK_NOT_YET_AUTHORIZED',
      'Phase 69A implements DRY-RUN preflight only. Sending a real Booking.com ' +
      'request requires a separate, future, explicitly-authorized instruction ' +
      '— this file has no code path capable of making that call today.'
    );
  }

  return {
    ok: true,
    blocked: false,
    dryRun: true,
    networkCallMade: false,
    preflight: {
      operation: OPERATION,
      method: 'POST',
      endpoint,
      headers,
      correlationId,
      bodyXmlPreview: xml,
      ledgerPlan: {
        table: 'ari_outbox_channel_delivery',
        note: 'a real (future, authorized) run would ensureDeliveryForTenant() -> claimForTenant() -> ' +
              'markCompletedForTenant()/markRetryForTenant()/markDeadLetterForTenant() based on the real response — the SAME state machine ariChannelDispatcher.js already uses, never a parallel one.',
        ledgerWriteExecutedInThisRun: false
      }
    }
  };
}

module.exports = { runDryRun, buildCorrelationId, OPERATION, PERMITTED_TEST_OPERATIONS };

// ---- manual CLI entry point (operator invocation only; never scheduled) ---
if (require.main === module) {
  console.log('QYRVIA Booking.com TEST-availability harness — DRY-RUN ONLY (Phase 69A / instruction 048).');
  console.log('This build has no network-sending capability. Call runDryRun({...}) from a Node REPL/script');
  console.log('with your own operator-verified {connectionStatus, credentialEnvironment, mapping, inventory}');
  console.log('inputs (this file performs no DB lookups of its own) to see the exact preflight request it');
  console.log('would build. Passing networkAuthorized:true throws NETWORK_NOT_YET_AUTHORIZED unconditionally.');
  process.exit(0);
}
