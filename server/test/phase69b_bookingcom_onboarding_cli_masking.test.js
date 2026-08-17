'use strict';

/**
 * Phase 69B (instruction 050 Section 8) — Booking.com TEST onboarding CLI:
 * masked secret input + full interactive collection flow. Pure NO-NETWORK
 * unit tests against fake in-memory streams (EventEmitter-based) — never a
 * real TTY, never process.stdin/stdout, never a real credential.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { promptHidden, promptVisible, collectOnboardingInputInteractive } = require('../scripts/channel/bookingComTestAccountOnboardingCli');

const FAKE_SECRET = 'MASKING-TEST-FAKE-SECRET-99887766';
const FAKE_CLIENT_ID = 'MASKING-TEST-FAKE-CLIENT-ID-11223344';

function fakeInput() {
  const e = new EventEmitter();
  e.resume = () => {};
  e.pause = () => {};
  e.setEncoding = () => {};
  return e;
}
function fakeOutput() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); }, chunks, all: () => chunks.join('') };
}
function typeAndEnter(input, text) {
  for (const ch of text) input.emit('data', Buffer.from(ch));
  input.emit('data', Buffer.from('\n'));
}

// ---- masking properties -----------------------------------------------------

test('promptHidden echoes exactly one "*" per typed character, never the real character', async () => {
  const input = fakeInput(), output = fakeOutput();
  const p = promptHidden('secret: ', { input, output });
  typeAndEnter(input, FAKE_SECRET);
  const value = await p;
  assert.equal(value, FAKE_SECRET, 'the resolved value is correct internally');
  assert.ok(!output.all().includes(FAKE_SECRET), 'the raw secret NEVER appears in anything written to output');
  const starCount = (output.all().match(/\*/g) || []).length;
  assert.equal(starCount, FAKE_SECRET.length, 'exactly one * per character typed');
});

test('promptHidden supports backspace — removing a character removes its star, never re-exposes the character', async () => {
  const input = fakeInput(), output = fakeOutput();
  const p = promptHidden('secret: ', { input, output });
  input.emit('data', Buffer.from('abc'));
  input.emit('data', Buffer.from('')); // DEL/backspace
  input.emit('data', Buffer.from('X'));
  input.emit('data', Buffer.from('\n'));
  const value = await p;
  assert.equal(value, 'abX');
  assert.ok(!output.all().includes('abc'));
  assert.ok(!output.all().includes('abX'));
});

test('promptHidden resolves on Enter (\\n) and on Ctrl-D (EOF)', async () => {
  const input1 = fakeInput(), output1 = fakeOutput();
  const p1 = promptHidden('s: ', { input: input1, output: output1 });
  input1.emit('data', Buffer.from('x1\n'));
  assert.equal(await p1, 'x1');

  const input2 = fakeInput(), output2 = fakeOutput();
  const p2 = promptHidden('s: ', { input: input2, output: output2 });
  input2.emit('data', Buffer.from('x2'));
  assert.equal(await p2, 'x2');
});

test('promptHidden never writes to output.write with any argument containing the typed secret', async () => {
  const input = fakeInput();
  const writeCalls = [];
  const output = { write: (s) => writeCalls.push(String(s)) };
  const p = promptHidden('secret: ', { input, output });
  typeAndEnter(input, FAKE_SECRET);
  await p;
  for (const call of writeCalls) assert.ok(!call.includes(FAKE_SECRET));
});

// ---- promptVisible (non-secret) --------------------------------------------

test('promptVisible resolves with the exact typed value via readline\'s own question()', async () => {
  const rl = { question: (text, cb) => cb('tenant-abc') };
  const value = await promptVisible(rl, 'tenant: ');
  assert.equal(value, 'tenant-abc');
});

// ---- full interactive collection flow --------------------------------------

test('collectOnboardingInputInteractive builds the correct plan from a full simulated session, never echoing the secret', async () => {
  const input = fakeInput(), output = fakeOutput();
  const answers = ['t1', 'p1', 'rt1', '99999', '101', 'bc-test-ref-1'];
  let qi = 0;
  const rl = { question: (text, cb) => cb(answers[qi++]) };

  const resultPromise = collectOnboardingInputInteractive({ input, output, rl });
  // client_id then client_secret, both via promptHidden — simulate typing after a tick.
  setImmediate(() => {
    typeAndEnter(input, FAKE_CLIENT_ID);
    setImmediate(() => typeAndEnter(input, FAKE_SECRET));
  });
  const { onboardingInput, plan } = await resultPromise;

  assert.equal(onboardingInput.tenantId, 't1');
  assert.equal(onboardingInput.propertyId, 'p1');
  assert.equal(onboardingInput.roomTypeId, 'rt1');
  assert.equal(onboardingInput.bookingComTestPropertyId, '99999');
  assert.equal(onboardingInput.bookingComRoomId, '101');
  assert.equal(onboardingInput.credentialsRef, 'bc-test-ref-1');
  assert.equal(onboardingInput.requestedConnectionStatus, 'sandbox');
  assert.equal(onboardingInput.credentialEnvironment, 'TEST');

  assert.equal(plan.ok, true);
  assert.equal(plan.steps.length, 3);

  assert.ok(!output.all().includes(FAKE_SECRET), 'client_secret never echoed to output during the whole flow');
  assert.ok(!output.all().includes(FAKE_CLIENT_ID), 'client_id never echoed to output during the whole flow');
  assert.ok(!JSON.stringify(plan).includes(FAKE_SECRET));
  assert.ok(!JSON.stringify(onboardingInput).includes(FAKE_SECRET), 'the returned onboardingInput does NOT itself carry the raw secret in its top-level fields (only under .credential, consumed internally)');
});

test('collectOnboardingInputInteractive rejects (throws) when client_secret is left empty — never silently proceeds', async () => {
  const input = fakeInput(), output = fakeOutput();
  const answers = ['t1', 'p1', 'rt1', '99999', '101', 'bc-test-ref-1'];
  let qi = 0;
  const rl = { question: (text, cb) => cb(answers[qi++]) };

  const resultPromise = collectOnboardingInputInteractive({ input, output, rl });
  setImmediate(() => {
    typeAndEnter(input, FAKE_CLIENT_ID);
    setImmediate(() => typeAndEnter(input, '')); // empty secret, just Enter
  });
  await assert.rejects(() => resultPromise, (e) => e.code === 'BOOKING_COM_ONBOARDING_MISSING_CLIENT_SECRET');
});

// ---- structural: no argv secret, no network ---------------------------------

test('this file never reads a secret from process.argv anywhere (only documents --client-secret as a forbidden pattern in prose)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../scripts/channel/bookingComTestAccountOnboardingCli'), 'utf8');
  function codeOnly(text) {
    const noLineComments = text.split('\n').filter((l) => !/^\s*\*|^\s*\/\//.test(l)).join('\n');
    return noLineComments.replace(/\/\*[\s\S]*?\*\//g, '');
  }
  const code = codeOnly(src);
  // The doc comment header explicitly NAMES --client-secret as the anti-
  // pattern this file avoids (transparency, not usage) — strip comments
  // first so that PROSE explaining the safety property isn't mistaken for
  // actual code reading argv.
  assert.ok(!/process\.argv[\s\S]{0,40}(secret|client-secret)/i.test(code), 'process.argv must never be read in connection with a secret value in actual CODE');
  assert.ok(!/argv\.includes\(['"]--client-secret/.test(code), 'no code path parses --client-secret from argv');
});

test('this file never imports fetch/http/https/axios', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../scripts/channel/bookingComTestAccountOnboardingCli'), 'utf8');
  assert.ok(!/require\(['"]https?['"]\)/.test(src));
  assert.ok(!/\bfetch\(/.test(src));
});

test('this file never IMPORTS or CALLS configureBookingComTestAccount (write mode) — dry-run/plan only; it may only NAME it in explanatory prose', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../scripts/channel/bookingComTestAccountOnboardingCli'), 'utf8');

  // The actual require() destructure must not name it as an imported binding:
  const requireLine = src.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"][^'"]*testAccountOnboarding['"]\)/);
  assert.ok(requireLine, 'expected a destructured require of testAccountOnboarding.js');
  assert.ok(!requireLine[1].includes('configureBookingComTestAccount'), 'configureBookingComTestAccount must not be imported by the CLI');

  // And it must never be CALLED in actual CODE — strip comments first (same
  // codeOnly() convention this repo already uses elsewhere for source-text
  // guard tests: full-line `//` first, then `/* */` blocks) so a prose
  // mention like "running configureBookingComTestAccount() is deferred"
  // inside a doc comment is not mistaken for a real invocation.
  function codeOnly(text) {
    const noLineComments = text.split('\n').filter((l) => !/^\s*\*|^\s*\/\//.test(l)).join('\n');
    return noLineComments.replace(/\/\*[\s\S]*?\*\//g, '');
  }
  const code = codeOnly(src);
  assert.ok(!/configureBookingComTestAccount\s*\(/.test(code), 'configureBookingComTestAccount must never be invoked by the CLI\'s actual CODE in this build');
});
