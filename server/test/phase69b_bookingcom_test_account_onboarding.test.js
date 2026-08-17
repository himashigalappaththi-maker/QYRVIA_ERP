'use strict';

/**
 * Phase 69B (instruction 050) — Booking.com TEST account onboarding: core
 * logic tests. Pure NO-NETWORK unit tests against
 * src/channel-manager/adapters/bookingcom/testAccountOnboarding.js, using
 * fake in-memory-shaped deps only — never a real DB, never real
 * infrastructure, never a real credential.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTestCredentialPayload, assertBookingComOnboardingSafe, planOnboarding,
  configureBookingComTestAccount, computeOnboardingPreflight, TARGET_OPERATION, CREDENTIAL_TYPE
} = require('../src/channel-manager/adapters/bookingcom/testAccountOnboarding');

const FAKE_SECRET = 'FAKE-CLIENT-SECRET-DO-NOT-USE-REAL-VALUE-xyz789';
const FAKE_CLIENT_ID = 'FAKE-CLIENT-ID-abc123';

function validInput(overrides) {
  return Object.assign({
    targetChannel: 'BOOKING_COM',
    requestedConnectionStatus: 'sandbox',
    mappingClassification: 'TEST',
    credentialEnvironment: 'TEST',
    existingRegistryStatus: null,
    tenantId: 't1', propertyId: 'p1', mappingTenantId: 't1', mappingPropertyId: 'p1',
    credentialsRef: 'bc-test-ref-1', mappingCredentialsRef: 'bc-test-ref-1',
    bookingComTestPropertyId: '99999', bookingComRoomId: '101', roomTypeId: 'rt1',
    liveGates: { ariBookingComLive: false, ariOutboxDispatchEnabled: false, ariOutboxWorkerEnabled: false, ariOutboxHttpEnabled: false, channelHttpEnabled: false },
    networkExecutionRequested: false,
    credential: { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_SECRET }
  }, overrides);
}

// ---- credential object contract (Section 9) --------------------------------

test('buildTestCredentialPayload produces exactly {client_id, client_secret, environment:TEST} — no invented fields', () => {
  const p = buildTestCredentialPayload({ clientId: FAKE_CLIENT_ID, clientSecret: FAKE_SECRET });
  assert.deepEqual(Object.keys(p).sort(), ['client_id', 'client_secret', 'environment']);
  assert.equal(p.client_id, FAKE_CLIENT_ID);
  assert.equal(p.client_secret, FAKE_SECRET);
  assert.equal(p.environment, 'TEST');
});

// ---- C/D: missing client_id / client_secret => blocked ---------------------

test('C. missing client_id is blocked, error message never contains any secret value', () => {
  assert.throws(() => buildTestCredentialPayload({ clientId: '', clientSecret: FAKE_SECRET }),
    (e) => e.code === 'BOOKING_COM_ONBOARDING_MISSING_CLIENT_ID' && !e.message.includes(FAKE_SECRET));
  assert.throws(() => buildTestCredentialPayload({ clientSecret: FAKE_SECRET }),
    (e) => e.code === 'BOOKING_COM_ONBOARDING_MISSING_CLIENT_ID');
});

test('D. missing client_secret is blocked, error message never contains the client_id either (defense in depth)', () => {
  assert.throws(() => buildTestCredentialPayload({ clientId: FAKE_CLIENT_ID, clientSecret: '' }),
    (e) => e.code === 'BOOKING_COM_ONBOARDING_MISSING_CLIENT_SECRET');
  assert.throws(() => buildTestCredentialPayload({ clientId: FAKE_CLIENT_ID }),
    (e) => e.code === 'BOOKING_COM_ONBOARDING_MISSING_CLIENT_SECRET' && !e.message.includes(FAKE_CLIENT_ID));
});

// ---- guard: A/K happy path --------------------------------------------------

test('A/K. a fully-valid TEST configuration is allowed and builds the intended 3-step plan', () => {
  const g = assertBookingComOnboardingSafe(validInput());
  assert.equal(g.allowed, true);
  assert.equal(g.reason, null);

  const plan = planOnboarding(validInput());
  assert.equal(plan.ok, true);
  assert.equal(plan.operation, TARGET_OPERATION);
  assert.deepEqual(plan.steps.map((s) => s.step), ['STORE_CREDENTIAL', 'SET_REGISTRY_SANDBOX', 'BIND_TEST_MAPPING']);
});

// ---- E: credential environment != TEST => blocked --------------------------

test('E. credential environment != TEST is blocked', () => {
  for (const env of ['PRODUCTION', null, undefined, 'test']) {
    const g = assertBookingComOnboardingSafe(validInput({ credentialEnvironment: env }));
    assert.equal(g.allowed, false);
    assert.equal(g.reason, 'CREDENTIAL_NOT_TEST_CLASSIFIED');
  }
});

// ---- F: connection status != sandbox => blocked -----------------------------

test('F. requesting anything other than sandbox is blocked — this flow can NEVER request live/production', () => {
  for (const status of ['live', 'production', 'configured', null, undefined]) {
    const g = assertBookingComOnboardingSafe(validInput({ requestedConnectionStatus: status }));
    assert.equal(g.allowed, false);
    assert.equal(g.reason, 'ONBOARDING_MUST_REQUEST_SANDBOX_ONLY');
  }
});

// ---- G: credentials_ref mismatch => blocked ---------------------------------

test('G. mapping credentials_ref not matching the credential being configured is blocked', () => {
  const g = assertBookingComOnboardingSafe(validInput({ mappingCredentialsRef: 'some-other-ref' }));
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'CREDENTIALS_REF_MISMATCH');
});

// ---- H: invalid/missing Booking.com room ID => blocked ----------------------

test('H. invalid or missing Booking.com room ID is blocked (reuses the same integer validation as the availability codec)', () => {
  for (const roomId of [null, undefined, '', 'R1', '0', '-1', '01', '1.5']) {
    const g = assertBookingComOnboardingSafe(validInput({ bookingComRoomId: roomId }));
    assert.equal(g.allowed, false);
    assert.equal(g.reason, 'INVALID_BOOKING_COM_ROOM_ID');
  }
});

// ---- I: live gate true => blocked -------------------------------------------

test('I. any active live/production gate is blocked, even with everything else valid', () => {
  for (const gate of ['ariBookingComLive', 'ariOutboxDispatchEnabled', 'ariOutboxWorkerEnabled', 'ariOutboxHttpEnabled', 'channelHttpEnabled']) {
    const liveGates = { ariBookingComLive: false, ariOutboxDispatchEnabled: false, ariOutboxWorkerEnabled: false, ariOutboxHttpEnabled: false, channelHttpEnabled: false };
    liveGates[gate] = true;
    const g = assertBookingComOnboardingSafe(validInput({ liveGates }));
    assert.equal(g.allowed, false);
    assert.equal(g.reason, 'PROVIDER_LIVE_MODE_SELECTED:' + gate);
  }
});

// ---- J: cannot overwrite an existing production/live registry --------------

test('J. an existing LIVE registry row can never be downgraded/overwritten by TEST onboarding (plan-time)', () => {
  const g = assertBookingComOnboardingSafe(validInput({ existingRegistryStatus: 'live' }));
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'REFUSED_WOULD_DOWNGRADE_LIVE_REGISTRY');
});

test('J. the SAME refusal is re-checked FRESH at write time, not just at plan time', async () => {
  const secretProvider = { put: async () => { throw new Error('should never be called — refused before any write'); } };
  const channelRegistry = {
    get: async () => ({ status: 'live' }), // the row became live BETWEEN planning and execution
    setStatus: async () => { throw new Error('should never be called'); }
  };
  const mappingService = { upsertMapping: async () => { throw new Error('should never be called'); } };
  const r = await configureBookingComTestAccount({ deps: { secretProvider, channelRegistry, mappingService }, input: validInput() });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'REFUSED_WOULD_DOWNGRADE_LIVE_REGISTRY');
});

// ---- other refusals: wrong channel, tenant/property mismatch ---------------

test('refuses a target channel other than BOOKING_COM', () => {
  const g = assertBookingComOnboardingSafe(validInput({ targetChannel: 'AGODA' }));
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'TARGET_CHANNEL_NOT_BOOKING_COM');
});

test('refuses when mapping classification is not exactly TEST', () => {
  const g = assertBookingComOnboardingSafe(validInput({ mappingClassification: 'PRODUCTION' }));
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'MAPPING_NOT_CLASSIFIED_TEST');
});

test('refuses a tenant/property mismatch between the credential and the mapping', () => {
  const g = assertBookingComOnboardingSafe(validInput({ mappingTenantId: 't2' }));
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'TENANT_PROPERTY_MISMATCH');
});

test('refuses when network execution is (somehow) requested', () => {
  const g = assertBookingComOnboardingSafe(validInput({ networkExecutionRequested: true }));
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'NETWORK_EXECUTION_NOT_AUTHORIZED_FOR_ONBOARDING');
});

// ---- B: missing CHANNEL_CREDENTIAL_KEY (no secretProvider) => blocked safely

test('B. configureBookingComTestAccount blocked safely when the credential subsystem is dormant (no secretProvider, i.e. CHANNEL_CREDENTIAL_KEY absent)', async () => {
  await assert.rejects(
    () => configureBookingComTestAccount({ deps: { secretProvider: null, channelRegistry: {}, mappingService: {} }, input: validInput() }),
    (e) => e.code === 'BOOKING_COM_ONBOARDING_SECRET_PROVIDER_UNAVAILABLE'
  );
});

// ---- K/L: plan construction + idempotency -----------------------------------

test('K. identical valid inputs always produce identical plans (pure function)', () => {
  const a = planOnboarding(validInput());
  const b = planOnboarding(validInput());
  assert.deepEqual(a, b);
});

test('L. configureBookingComTestAccount is idempotent — running it twice against upsert-style fakes never creates duplicates', async () => {
  const credentialRows = new Map(); // (tenant::ref) -> payload
  const registryRows = new Map();   // tenant::property -> status
  const mappingRows = new Map();    // tenant::property::room -> row

  const secretProvider = {
    put: async (ref, payload, meta) => {
      const key = meta.tenant_id + '::' + ref;
      credentialRows.set(key, { payload, meta });
    }
  };
  const channelRegistry = {
    get: async (channel, ctx) => {
      const key = ctx.tenantId + '::' + ctx.propertyId;
      return registryRows.has(key) ? { status: registryRows.get(key) } : null;
    },
    setStatus: async (channel, status, ctx) => { registryRows.set(ctx.tenantId + '::' + ctx.propertyId, status); }
  };
  const mappingService = {
    upsertMapping: async (row) => {
      const key = row.tenant_id + '::' + row.property_id + '::' + row.room_type_id;
      mappingRows.set(key, row);
    }
  };
  const deps = { secretProvider, channelRegistry, mappingService };

  const r1 = await configureBookingComTestAccount({ deps, input: validInput() });
  const r2 = await configureBookingComTestAccount({ deps, input: validInput() });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(credentialRows.size, 1, 'no duplicate credential row');
  assert.equal(registryRows.size, 1, 'no duplicate registry row');
  assert.equal(mappingRows.size, 1, 'no duplicate mapping row');
});

// ---- M: structural — no external HTTP -------------------------------------

test('M. this module never imports fetch/http/https/axios', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../src/channel-manager/adapters/bookingcom/testAccountOnboarding'), 'utf8');
  assert.ok(!/require\(['"]https?['"]\)/.test(src));
  assert.ok(!/require\(['"]axios['"]\)/.test(src));
  assert.ok(!/\bfetch\(/.test(src));
});

// ---- Section 19: secret-redaction tests -------------------------------------

test('client_secret never appears in the plan output', () => {
  const plan = planOnboarding(validInput());
  assert.ok(!JSON.stringify(plan).includes(FAKE_SECRET));
});

test('client_secret never appears in ANY guard-failure reason string, across every failure path', () => {
  const failureInputs = [
    validInput({ credentialEnvironment: 'PRODUCTION' }),
    validInput({ requestedConnectionStatus: 'live' }),
    validInput({ mappingCredentialsRef: 'x' }),
    validInput({ bookingComRoomId: 'bad' }),
    validInput({ liveGates: { ariBookingComLive: true } }),
    validInput({ existingRegistryStatus: 'live' }),
    validInput({ targetChannel: 'AGODA' })
  ];
  for (const input of failureInputs) {
    const g = assertBookingComOnboardingSafe(input);
    assert.equal(g.allowed, false);
    assert.ok(!JSON.stringify(g).includes(FAKE_SECRET));
    const plan = planOnboarding(input);
    assert.ok(!JSON.stringify(plan).includes(FAKE_SECRET));
  }
});

test('client_secret never appears in a thrown validation error message', () => {
  try { buildTestCredentialPayload({ clientId: '', clientSecret: FAKE_SECRET }); assert.fail('should have thrown'); }
  catch (e) { assert.ok(!e.message.includes(FAKE_SECRET)); assert.ok(!String(e).includes(FAKE_SECRET)); }
});

test('client_secret never appears in onAudit logger calls — only safe metadata is emitted', async () => {
  const audited = [];
  const secretProvider = { put: async () => {} };
  const channelRegistry = { get: async () => null, setStatus: async () => {} };
  const mappingService = { upsertMapping: async () => {} };
  await configureBookingComTestAccount({
    deps: { secretProvider, channelRegistry, mappingService, onAudit: (evt) => audited.push(evt) },
    input: validInput()
  });
  assert.ok(audited.length >= 3, 'all three steps audited');
  const serialized = JSON.stringify(audited);
  assert.ok(!serialized.includes(FAKE_SECRET), 'client_secret never logged');
  assert.ok(!serialized.toLowerCase().includes('authorization'), 'Authorization never logged');
  assert.ok(!serialized.toLowerCase().includes('jwt'), 'JWT never logged');
  assert.ok(!serialized.toLowerCase().includes('encrypted_payload'), 'encrypted payload never logged');
  // Allowed/expected safe fields ARE present:
  assert.ok(serialized.includes('credentials_ref'), 'credentials_ref (a reference, never a secret) IS logged where operationally useful');
  assert.ok(serialized.includes('t1'), 'tenant_id IS logged');
});

test('mocked client_secret reaches ONLY the secretProvider.put() call — never registry.setStatus, never mappingService.upsertMapping, never the return value', async () => {
  let putArgs = null, setStatusArgs = null, upsertArgs = null;
  const secretProvider = { put: async (ref, payload, meta) => { putArgs = { ref, payload, meta }; } };
  const channelRegistry = { get: async () => null, setStatus: async (...args) => { setStatusArgs = args; } };
  const mappingService = { upsertMapping: async (row) => { upsertArgs = row; } };
  const result = await configureBookingComTestAccount({ deps: { secretProvider, channelRegistry, mappingService }, input: validInput() });

  assert.equal(putArgs.payload.client_secret, FAKE_SECRET, 'the secret DOES reach the one place it must: the encrypted store boundary');
  assert.ok(!JSON.stringify(setStatusArgs).includes(FAKE_SECRET), 'never reaches registry.setStatus');
  assert.ok(!JSON.stringify(upsertArgs).includes(FAKE_SECRET), 'never reaches mappingService.upsertMapping');
  assert.ok(!JSON.stringify(result).includes(FAKE_SECRET), 'never appears in the operator-facing return value');
});

test('no raw credential object is returned from configureBookingComTestAccount — only step names/booleans', async () => {
  const secretProvider = { put: async () => {} };
  const channelRegistry = { get: async () => null, setStatus: async () => {} };
  const mappingService = { upsertMapping: async () => {} };
  const result = await configureBookingComTestAccount({ deps: { secretProvider, channelRegistry, mappingService }, input: validInput() });
  assert.deepEqual(Object.keys(result).sort(), ['blocked', 'ok', 'steps']);
  assert.ok(Array.isArray(result.steps) && result.steps.every((s) => typeof s === 'string'));
});

test('credentials_ref MAY be returned where operationally necessary — it is not a secret', () => {
  const plan = planOnboarding(validInput());
  assert.equal(plan.steps[0].credentialsRef, 'bc-test-ref-1');
});

// ---- operator preflight (Section 14): booleans only -------------------------

test('computeOnboardingPreflight returns ONLY boolean fields, no secret/token/encrypted-payload values', async () => {
  const out = await computeOnboardingPreflight({
    deps: {
      channelCredentialsStore: { get: async () => ({ status: 'ACTIVE' }) },
      channelRegistry: { get: async () => ({ status: 'sandbox' }) },
      mappingService: { getMapping: async () => ({ credentials_ref: 'bc-test-ref-1', ota_room_id: '101', ota_property_id: '99999' }) },
      channelCredentialKeyPresent: true,
      liveGatesAllFalse: true
    },
    args: { tenantId: 't1', propertyId: 'p1', roomTypeId: 'rt1', credentialsRef: 'bc-test-ref-1' }
  });
  for (const [k, v] of Object.entries(out)) assert.equal(typeof v, 'boolean', k + ' must be boolean');
  assert.equal(out.CHANNEL_CREDENTIAL_KEY_PRESENT, true);
  assert.equal(out.BOOKING_COM_TEST_CREDENTIAL_REF_PRESENT, true);
  assert.equal(out.BOOKING_COM_CHANNEL_REGISTRY_SANDBOX_READY, true);
  assert.equal(out.BOOKING_COM_TEST_MAPPING_PRESENT, true);
  assert.equal(out.BOOKING_COM_MAPPING_CREDENTIAL_REF_MATCH, true);
  assert.equal(out.BOOKING_COM_TEST_ROOM_ID_VALID, true);
  assert.equal(out.BOOKING_COM_TEST_PROPERTY_ID_PRESENT, true);
  assert.equal(out.BOOKING_COM_LIVE_GATES_ALL_FALSE, true);
  assert.equal(out.BOOKING_COM_DRY_RUN_CODEC_READY, true);
  assert.ok(!JSON.stringify(out).toLowerCase().includes('secret'));
});

test('computeOnboardingPreflight defaults every boolean to false/safe when nothing is configured yet', async () => {
  const out = await computeOnboardingPreflight({ deps: {}, args: { tenantId: 't1', propertyId: 'p1', roomTypeId: 'rt1', credentialsRef: 'ref' } });
  assert.equal(out.CHANNEL_CREDENTIAL_KEY_PRESENT, false);
  assert.equal(out.BOOKING_COM_TEST_CREDENTIAL_REF_PRESENT, false);
  assert.equal(out.BOOKING_COM_CHANNEL_REGISTRY_SANDBOX_READY, false);
  assert.equal(out.BOOKING_COM_TEST_MAPPING_PRESENT, false);
});

test('computeOnboardingPreflight never throws even when every dep is missing', async () => {
  await assert.doesNotReject(() => computeOnboardingPreflight({}));
});

// ---- constants sanity --------------------------------------------------------

test('CREDENTIAL_TYPE is an existing valid channel_credential_store enum value (OAUTH2)', () => {
  assert.equal(CREDENTIAL_TYPE, 'OAUTH2');
});
test('TARGET_OPERATION matches testPropertyGuard.js\'s PERMITTED_TEST_OPERATIONS entry', () => {
  const { PERMITTED_TEST_OPERATIONS } = require('../src/channel-manager/adapters/bookingcom/testPropertyGuard');
  assert.ok(PERMITTED_TEST_OPERATIONS.includes(TARGET_OPERATION));
});
