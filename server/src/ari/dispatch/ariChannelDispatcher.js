'use strict';

/**
 * Phase 68A — the ARI -> canonical channel -> Booking.com transport
 * dispatcher (instruction 032). Satisfies EXACTLY the dispatcher contract
 * src/ari/outbox/ariOutboxWorker.js already requires and does not modify:
 *
 *   dispatcher.isReady()      -> boolean
 *   dispatcher.dispatch(envelope) -> Promise<void>  (resolve = success, reject = failure)
 *
 * WHY THIS FILE EXISTS (P0 closed, not hand-waved)
 * ─────────────────────────────────────────────────
 * Instruction 031's audit proved the committed ariOutboxWorker envelope
 * carries NO channel field — fan-out across a property's enabled channels is
 * entirely this dispatcher's job — and that a retried outbox row could
 * otherwise redeliver to a channel that already succeeded. Every channel
 * attempt this dispatcher makes is therefore preceded by a DURABLE ledger
 * check (src/ari/dispatch/ariChannelDeliveryStore.js, migration 0091) —
 * never an in-memory or log-only record — and a channel already COMPLETED
 * for this exact ARI outbox row is skipped BEFORE any provider is ever
 * contacted again.
 *
 * NOT-LIVE BY CONSTRUCTION
 * ─────────────────────────
 * isReady() requires env.ARI_BOOKING_COM_LIVE === 'true' IN ADDITION TO every
 * dependency being present — this is a fourth, independent gate stacked on
 * top of ARI_OUTBOX_WORKER_ENABLED and ARI_OUTBOX_DISPATCH_ENABLED (which
 * gate whether ariOutboxWorker.tick() ever calls a dispatcher at all) and
 * CHANNEL_HTTP_ENABLED (which gates whether buildHttpTransport leaves
 * disabled mode). All four default false. With any one of them false, no
 * HTTP byte reaches Booking.com and no ari_outbox_store row is ever claimed.
 *
 * CHANNEL SELECTION POLICY (instruction Section 9)
 * ──────────────────────────────────────────────────
 *   QYRVIA_CONNECT — delivered via the existing real in-process transport
 *     (src/channel-manager/transport/transport.js buildInProcessTransport),
 *     exactly as it already is elsewhere in this codebase. No network, no
 *     credential, no OTA mapping required — QYRVIA's own canonical IDs are
 *     already the "OTA" IDs.
 *   BOOKING_COM — the one external provider this phase supports, gated by
 *     ARI_BOOKING_COM_LIVE.
 *   every other canonical channel — UNSUPPORTED_FOR_ARI_TRANSPORT: recorded
 *     durably as a non-retryable DEAD_LETTER ledger entry (never silently
 *     skipped, never marked COMPLETED) and the whole envelope dispatch
 *     rejects. A property that has enabled a channel this phase cannot
 *     deliver to must never appear to have succeeded.
 */

const { canonicalChannelCode } = require('../../channel-manager/services/channelEventRouter');
const { CredentialAuthStrategy } = require('../../channel-manager/adapters/framework/AuthStrategy');
const { buildOtaTransport } = require('../../channel-manager/ota/transport');
const { buildInProcessTransport } = require('../../channel-manager/transport/transport');
const otaProviders = require('../../channel-manager/ota/providers');
const { mapAriEnvelope, OPERATIONS } = require('./ariRateMapping');
const {
  ensureDeliveryForTenant, claimForTenant, markCompletedForTenant,
  markRetryForTenant, markDeadLetterForTenant,
  allRequiredChannelsComplete, STATUS, ERROR_CLASS
} = require('./tenantAriChannelDelivery');

const QYRVIA_CONNECT = 'QYRVIA_CONNECT';
const BOOKING_COM = 'BOOKING_COM';
// Instruction 032 Section 5: "Do NOT add Expedia/Agoda/Airbnb/MakeMyTrip/
// Google/TripAdvisor delivery yet." Deliberately a single-entry set, not a
// config flag — widening it is a future phase's explicit, reviewed change.
const SUPPORTED_EXTERNAL_CHANNELS = Object.freeze([BOOKING_COM]);

function fail(message, retryable) {
  const e = new Error('ariChannelDispatcher: ' + message);
  // Explicit both ways when the caller states an opinion — leaving `true`
  // implicit (unset) would still classify as retryable under
  // ariOutboxWorker.js's own isRetryable() convention (absence of
  // `retryable === false` defaults retryable), but stating it explicitly
  // here removes any ambiguity for a future reader of THIS module's errors.
  if (retryable !== undefined) e.retryable = !!retryable;
  return e;
}

function isRetryableError(err) {
  return !(err && err.retryable === false);
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Step 1 (Section 8 #1): validate the envelope identity before touching anything. */
function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') throw fail('envelope is required', false);
  const { id, tenantId, propertyId, eventType, dedupeKey, sourceVersion } = envelope;
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw fail('envelope.id must be a UUID', false);
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) throw fail('envelope.tenantId must be a UUID', false);
  if (typeof propertyId !== 'string' || !UUID_RE.test(propertyId)) throw fail('envelope.propertyId must be a UUID', false);
  if (typeof eventType !== 'string' || eventType.length === 0) throw fail('envelope.eventType is required', false);
  if (typeof dedupeKey !== 'string' || dedupeKey.length === 0) throw fail('envelope.dedupeKey is required', false);
  if (!Number.isInteger(sourceVersion) || sourceVersion < 1) throw fail('envelope.sourceVersion must be a positive integer', false);
}

/**
 * @param {object} deps
 * @param {{query:Function, connect:Function}} deps.pool
 * @param {Function} deps.resolveChannels     services/enabledChannelResolver.js instance:
 *        ({tenantId, propertyId}) => Promise<string[]> — REUSED UNCHANGED.
 * @param {{get:Function}} deps.channelRegistry   channelRegistryService instance.
 * @param {{get:Function}} deps.secretProvider    SecretProvider instance.
 * @param {Function} deps.resolveCredentialsRef   ({tenantId, propertyId, channelCode}) =>
 *        Promise<string|null> — resolves which channel_credential_store row (its
 *        credentials_ref) authorizes this (tenant, property, channel). REQUIRED,
 *        injected — this module deliberately does not invent a second credential
 *        store or a new lookup convention; the caller supplies this against the
 *        EXISTING store (src/channel-manager/credentials/*).
 * @param {{getMapping:Function}} deps.mappingService   channelMappingService instance.
 * @param {object}   [deps.http]        shared buildHttpTransport() instance (default-disabled).
 * @param {object}   [deps.activations] CHANNEL_OTA_ACTIVATIONS-shaped map (channel -> {endpoint}),
 *        same convention channel-manager/sync/index.js already uses — NOT a second config surface.
 * @param {object}   [deps.providers]   ota/providers module (default require(...)).
 * @param {Function} [deps.isLive]      () => boolean, default reads env.ARI_BOOKING_COM_LIVE.
 * @param {Function} [deps.clock]
 * @param {object}   [deps.logger]
 */
function buildAriChannelDispatcher({
  pool, resolveChannels, channelRegistry, secretProvider, resolveCredentialsRef,
  mappingService, http, activations, providers, isLive, clock, logger
} = {}) {
  const _providers = providers || otaProviders;
  const _activations = activations || {};
  const _isLive = typeof isLive === 'function'
    ? isLive
    : () => require('../../config/env').ARI_BOOKING_COM_LIVE === 'true';
  const log = logger || { info() {}, warn() {}, error() {}, debug() {} };

  // Fail closed at construction — mirrors ariOutboxWorker.js's own
  // constructor guards exactly: a dispatcher missing a dependency must never
  // silently boot into a state where isReady() could somehow read true.
  const dependenciesOk = !!(
    pool && typeof pool.connect === 'function' &&
    typeof resolveChannels === 'function' &&
    channelRegistry && typeof channelRegistry.get === 'function' &&
    secretProvider && typeof secretProvider.get === 'function' &&
    typeof resolveCredentialsRef === 'function' &&
    mappingService && typeof mappingService.getMapping === 'function'
  );

  const qyrviaConnectTransport = buildInProcessTransport();

  function endpointFor(channelCode) {
    const act = _activations[channelCode];
    return (act && act.endpoint) || null;
  }

  /** One durable ledger row -> {ok, retryable, code}. Never throws. */
  async function attemptQyrviaConnect(envelope, deliveryId) {
    try {
      const claimed = await claimForTenant({ pool, tenantId: envelope.tenantId, id: deliveryId });
      if (!claimed) return { ok: false, retryable: true, code: 'claim_conflict' };
      const ack = await qyrviaConnectTransport.send({
        channel: QYRVIA_CONNECT,
        op: envelope.eventType,
        payload: {
          id: envelope.id, eventType: envelope.eventType, resourceKind: envelope.resourceKind,
          roomTypeId: envelope.roomTypeId, ratePlanId: envelope.ratePlanId,
          effectiveFrom: envelope.effectiveFrom, effectiveTo: envelope.effectiveTo,
          sourceVersion: envelope.sourceVersion, payload: envelope.payload
        }
      });
      if (ack && ack.ok) {
        await markCompletedForTenant({ pool, tenantId: envelope.tenantId, id: deliveryId, providerAckId: ack.ackId || null });
        return { ok: true };
      }
      await markRetryForTenant({ pool, tenantId: envelope.tenantId, id: deliveryId, errorCode: 'qyrvia_connect_dispatch_error', errorClass: ERROR_CLASS.RETRYABLE });
      return { ok: false, retryable: true, code: 'qyrvia_connect_dispatch_error' };
    } catch (e) {
      await markRetryForTenant({ pool, tenantId: envelope.tenantId, id: deliveryId, errorCode: String((e && e.message) || e).slice(0, 120), errorClass: ERROR_CLASS.RETRYABLE });
      return { ok: false, retryable: true, code: 'qyrvia_connect_exception' };
    }
  }

  async function markUnsupported(envelope, deliveryId) {
    const claimed = await claimForTenant({ pool, tenantId: envelope.tenantId, id: deliveryId });
    // Whether or not the claim itself succeeded, the outcome is the same
    // non-retryable verdict — an unsupported channel never becomes supported
    // by retrying, so a claim race here still ends at DEAD_LETTER logically;
    // if we actually hold the row we durably record why.
    if (claimed) {
      await markDeadLetterForTenant({ pool, tenantId: envelope.tenantId, id: deliveryId, errorCode: 'UNSUPPORTED_FOR_ARI_TRANSPORT', errorClass: ERROR_CLASS.NON_RETRYABLE });
    }
    return { ok: false, retryable: false, code: 'UNSUPPORTED_FOR_ARI_TRANSPORT' };
  }

  /**
   * BOOKING_COM (and, unchanged in shape, any future SUPPORTED_EXTERNAL_CHANNELS
   * entry) attempt. Every fail-closed check the instruction lists (Section 8
   * #8-#11) runs BEFORE the ledger row is even claimed, so an unauthorized/
   * unmapped/uncredentialed channel never transitions to PROCESSING for
   * nothing — but the row IS still durably recorded once claimed, so the
   * refusal itself is auditable.
   */
  async function attemptExternalChannel(envelope, deliveryId, channelCode) {
    const tenantId = envelope.tenantId, propertyId = envelope.propertyId;

    // #8/#J — fresh, uncached registry authorization (mirrors realProcessor.js's
    // own "fresh per call, never cached" discipline exactly).
    let reg;
    try { reg = await channelRegistry.get(channelCode, { tenantId, propertyId }); }
    catch (_) { reg = null; }
    if (!reg || reg.enabled !== true) {
      const claimed = await claimForTenant({ pool, tenantId, id: deliveryId });
      if (claimed) await markRetryForTenant({ pool, tenantId, id: deliveryId, errorCode: 'channel_disabled', errorClass: ERROR_CLASS.RETRYABLE });
      return { ok: false, retryable: true, code: 'channel_disabled' };
    }

    // #11 — credential reference must resolve to something BEFORE any claim/attempt.
    let credentialsRef = null;
    try { credentialsRef = await resolveCredentialsRef({ tenantId, propertyId, channelCode }); }
    catch (_) { credentialsRef = null; }
    if (!credentialsRef) {
      const claimed = await claimForTenant({ pool, tenantId, id: deliveryId });
      if (claimed) await markDeadLetterForTenant({ pool, tenantId, id: deliveryId, errorCode: 'MISSING_CREDENTIAL_REF', errorClass: ERROR_CLASS.NON_RETRYABLE });
      return { ok: false, retryable: false, code: 'MISSING_CREDENTIAL_REF' };
    }
    let secret = null;
    try { secret = await secretProvider.get(credentialsRef, { tenant_id: tenantId }); }
    catch (_) { secret = null; }
    if (!secret) {
      const claimed = await claimForTenant({ pool, tenantId, id: deliveryId });
      if (claimed) await markDeadLetterForTenant({ pool, tenantId, id: deliveryId, errorCode: 'UNRESOLVABLE_CREDENTIAL', errorClass: ERROR_CLASS.NON_RETRYABLE });
      return { ok: false, retryable: false, code: 'UNRESOLVABLE_CREDENTIAL' };
    }

    // #10 — OTA mapping, via the pure mapper + the EXISTING channel mapping service.
    let mapped;
    try {
      const row = await mappingService.getMapping(tenantId, propertyId, channelCode, envelope.roomTypeId);
      const mapping = row ? { otaPropertyId: row.ota_property_id, otaRoomId: row.ota_room_id, otaRatePlanId: row.ota_rate_plan_id } : null;
      mapped = mapAriEnvelope(envelope, mapping);
    } catch (e) {
      const claimed = await claimForTenant({ pool, tenantId, id: deliveryId });
      const retryable = isRetryableError(e);
      if (claimed) {
        await (retryable
          ? markRetryForTenant({ pool, tenantId, id: deliveryId, errorCode: (e && e.code) || 'ARI_MAPPING_ERROR', errorClass: ERROR_CLASS.RETRYABLE })
          : markDeadLetterForTenant({ pool, tenantId, id: deliveryId, errorCode: (e && e.code) || 'ARI_MAPPING_ERROR', errorClass: ERROR_CLASS.NON_RETRYABLE }));
      }
      return { ok: false, retryable, code: (e && e.code) || 'ARI_MAPPING_ERROR' };
    }

    // #9 — provider implementation and endpoint must exist before claiming.
    let provider;
    try { provider = _providers.getProvider(channelCode); }
    catch (_) {
      const claimed = await claimForTenant({ pool, tenantId, id: deliveryId });
      if (claimed) await markDeadLetterForTenant({ pool, tenantId, id: deliveryId, errorCode: 'no_provider_for_channel', errorClass: ERROR_CLASS.NON_RETRYABLE });
      return { ok: false, retryable: false, code: 'no_provider_for_channel' };
    }
    const endpoint = endpointFor(channelCode);
    if (!endpoint) {
      const claimed = await claimForTenant({ pool, tenantId, id: deliveryId });
      if (claimed) await markDeadLetterForTenant({ pool, tenantId, id: deliveryId, errorCode: 'MISSING_ENDPOINT', errorClass: ERROR_CLASS.NON_RETRYABLE });
      return { ok: false, retryable: false, code: 'MISSING_ENDPOINT' };
    }

    // All preconditions satisfied — now, and only now, claim and attempt delivery.
    const claimed = await claimForTenant({ pool, tenantId, id: deliveryId });
    if (!claimed) return { ok: false, retryable: true, code: 'claim_conflict' };

    try {
      const auth = new CredentialAuthStrategy({
        credentialsRef, tenantId, secretProvider, toHeaders: (s) => provider.authToHeaders(s)
      });
      const transport = buildOtaTransport({ provider, http, auth, clock });
      const ctx = { endpoint, correlationId: envelope.dedupeKey + ':' + envelope.sourceVersion };
      const ack = mapped.operation === OPERATIONS.RATE
        ? await transport.pushRateUpdate(mapped.input, ctx)
        : await transport.pushAvailability(mapped.input, ctx);

      if (ack && ack.ok) {
        await markCompletedForTenant({ pool, tenantId, id: deliveryId, providerAckId: ack.ackId || null });
        return { ok: true };
      }
      const retryable = !!(ack && ack.retryable);
      const code = (ack && ack.errors && ack.errors[0] && ack.errors[0].code) || 'transport_error';
      await (retryable
        ? markRetryForTenant({ pool, tenantId, id: deliveryId, errorCode: code, errorClass: ERROR_CLASS.RETRYABLE })
        : markDeadLetterForTenant({ pool, tenantId, id: deliveryId, errorCode: code, errorClass: ERROR_CLASS.NON_RETRYABLE }));
      return { ok: false, retryable, code };
    } catch (e) {
      const retryable = isRetryableError(e);
      const code = (e && e.code) || String((e && e.message) || e).slice(0, 120);
      await (retryable
        ? markRetryForTenant({ pool, tenantId, id: deliveryId, errorCode: code, errorClass: ERROR_CLASS.RETRYABLE })
        : markDeadLetterForTenant({ pool, tenantId, id: deliveryId, errorCode: code, errorClass: ERROR_CLASS.NON_RETRYABLE }));
      return { ok: false, retryable, code };
    }
  }

  return {
    /** False unless every dependency AND the Booking.com LIVE gate are ready. */
    isReady() {
      if (!dependenciesOk) return false;
      return _isLive() === true;
    },

    /**
     * @param {object} envelope  frozen delivery envelope from ariOutboxWorker.js
     *        (buildDeliveryEnvelope) — never mutated here.
     * @returns {Promise<void>}  resolves iff EVERY required channel is durably
     *          COMPLETED; rejects (retryable per isRetryableError) otherwise.
     */
    async dispatch(envelope) {
      validateEnvelope(envelope);

      // #2/#3 — reuse enabledChannelResolver.js UNCHANGED; it already
      // canonicalizes legacy codes on read. Re-canonicalize defensively here
      // too (never trust a single layer alone) and drop anything that still
      // fails to canonicalize rather than propagate a legacy/unknown code.
      let resolved;
      try { resolved = await resolveChannels({ tenantId: envelope.tenantId, propertyId: envelope.propertyId }); }
      catch (e) { throw fail('channel resolution failed: ' + String((e && e.message) || e), true); }
      if (!Array.isArray(resolved)) throw fail('channel resolver returned a non-array result', true);

      const required = [];
      const seen = new Set();
      for (const raw of resolved) {
        const code = canonicalChannelCode(raw);
        if (!code || seen.has(code)) continue; // #8 — unrecognisable codes are dropped, never guessed
        seen.add(code);
        required.push(code);
      }

      if (required.length === 0) return; // nothing enabled for this property — legitimately nothing to do

      const outcomes = [];
      for (const channelCode of required) {
        // #5/#6/#7 — idempotent ensure, then inspect BEFORE any provider call.
        const { row } = await ensureDeliveryForTenant({
          pool, tenantId: envelope.tenantId, propertyId: envelope.propertyId,
          ariOutboxId: envelope.id, channelCode,
          dedupeKey: envelope.dedupeKey, sourceVersion: envelope.sourceVersion
        });
        if (!row) { outcomes.push({ channel: channelCode, ok: false, retryable: true, code: 'ledger_write_failed' }); continue; }
        if (row.status === STATUS.COMPLETED) { outcomes.push({ channel: channelCode, ok: true, skipped: true }); continue; }

        if (channelCode === QYRVIA_CONNECT) {
          outcomes.push(Object.assign({ channel: channelCode }, await attemptQyrviaConnect(envelope, row.id)));
        } else if (SUPPORTED_EXTERNAL_CHANNELS.includes(channelCode)) {
          outcomes.push(Object.assign({ channel: channelCode }, await attemptExternalChannel(envelope, row.id, channelCode)));
        } else {
          outcomes.push(Object.assign({ channel: channelCode }, await markUnsupported(envelope, row.id)));
        }
      }

      const complete = allRequiredChannelsComplete(
        outcomes.map((o) => ({ channel_code: o.channel, status: o.ok ? STATUS.COMPLETED : 'INCOMPLETE' })),
        required
      );
      if (complete) return;

      const failures = outcomes.filter((o) => !o.ok);
      // #12/#13 — retryable unless EVERY failing channel was itself non-retryable.
      const anyRetryable = failures.some((f) => f.retryable !== false);
      log.warn({ ariOutboxId: envelope.id, tenantId: envelope.tenantId, outcomes }, '[ari-channel-dispatcher] envelope not fully delivered');
      throw fail(
        'envelope ' + envelope.id + ' incomplete: ' + failures.map((f) => f.channel + '=' + f.code).join(', '),
        anyRetryable
      );
    }
  };
}

module.exports = { buildAriChannelDispatcher, SUPPORTED_EXTERNAL_CHANNELS, QYRVIA_CONNECT, BOOKING_COM };
