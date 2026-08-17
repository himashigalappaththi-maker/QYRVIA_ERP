'use strict';

/**
 * Phase 69B (instruction 050) — LOCAL, interactive Booking.com TEST account
 * onboarding CLI. DRY-RUN / PREFLIGHT ONLY in this build — see file-bottom
 * CLI entry point.
 *
 * ZERO NETWORK. This file never imports fetch/http/https/axios and never
 * contacts Booking.com.
 *
 * SECRET INPUT SAFETY (instruction 050 Section 8):
 *   - client_secret is NEVER accepted as a command-line argument (no
 *     --client-secret=..., no positional arg) — process.argv is never
 *     inspected for a secret value anywhere in this file (grep-provably:
 *     the only process.argv read below is the CLI-entry-point's own
 *     require.main guard, which reads no flags related to secrets at all).
 *   - client_secret is collected via promptHidden(): masked, non-echo TTY
 *     entry — each keystroke prints `*` to the terminal, never the typed
 *     character, and the accumulated value is held only in a local
 *     variable, never written to a file, log, or returned through any
 *     printed output.
 *   - client_id is ALSO masked by promptHidden() here (even though
 *     Booking.com documents it as less sensitive than client_secret) —
 *     "do not gratuitously log it" (instruction Section 8) is satisfied
 *     most simply by treating both identically rather than partially
 *     relaxing the safer path.
 *
 * The collected values are held ONLY in local variables for the lifetime
 * of one CLI invocation, passed directly to testAccountOnboarding.js's
 * pure functions, and never printed, logged, or persisted by this file.
 */

const readline = require('readline');
const {
  buildTestCredentialPayload, planOnboarding
} = require('../../src/channel-manager/adapters/bookingcom/testAccountOnboarding');

// Explicit named control-character constants (\uXXXX escapes — never raw
// embedded bytes in source, which would be invisible/fragile/hard to audit).
const KEY_ENTER_LF = '\n';
const KEY_ENTER_CR = '\r';
const KEY_EOF_CTRL_D = '\u0004';
const KEY_INTERRUPT_CTRL_C = '\u0003';
const KEY_BACKSPACE_DEL = '\u007f';
const KEY_BACKSPACE_BS = '\b';

/**
 * Masked (non-echo) prompt: prints `promptText`, then echoes `*` per
 * keystroke instead of the real character. Injectable input/output for
 * testing without a real TTY. Resolves to the collected string on Enter or
 * Ctrl-D. Backspace/Delete removes the last character (and its `*`).
 * Ctrl-C aborts the process (never resolves with a partial secret silently
 * swallowed).
 */
function promptHidden(promptText, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    output.write(promptText);
    let buf = '';
    const isRealTty = typeof input.setRawMode === 'function';
    if (isRealTty) input.setRawMode(true);
    input.resume();
    if (typeof input.setEncoding === 'function') input.setEncoding('utf8');

    function finish() {
      if (isRealTty) input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      output.write('\n');
      resolve(buf);
    }

    function onData(chunk) {
      const str = chunk.toString('utf8');
      for (const ch of str) {
        if (ch === KEY_ENTER_LF || ch === KEY_ENTER_CR || ch === KEY_EOF_CTRL_D) {
          finish();
          return;
        }
        if (ch === KEY_INTERRUPT_CTRL_C) {
          if (isRealTty) input.setRawMode(false);
          output.write('\n');
          process.exit(130);
          return;
        }
        if (ch === KEY_BACKSPACE_DEL || ch === KEY_BACKSPACE_BS) {
          if (buf.length) { buf = buf.slice(0, -1); output.write('\b \b'); }
          continue;
        }
        buf += ch;
        output.write('*'); // NEVER the real character
      }
    }
    input.on('data', onData);
  });
}

/** Ordinary (visible) prompt for non-secret identifiers — thin wrapper over readline. */
function promptVisible(rl, promptText) {
  return new Promise((resolve) => rl.question(promptText, (answer) => resolve(answer)));
}

/**
 * Orchestrates the full interactive collection. NEVER writes server/.env,
 * NEVER calls configureBookingComTestAccount() (write mode) — this
 * function only builds an in-memory input object and returns the
 * corresponding DRY-RUN plan via planOnboarding(). Injectable
 * input/output/rl so this is fully unit-testable without a real TTY.
 */
async function collectOnboardingInputInteractive({ input = process.stdin, output = process.stdout, rl } = {}) {
  const iface = rl || readline.createInterface({ input, output });
  try {
    const tenantId = await promptVisible(iface, 'QYRVIA tenant ID: ');
    const propertyId = await promptVisible(iface, 'QYRVIA property ID: ');
    const roomTypeId = await promptVisible(iface, 'QYRVIA room type ID: ');
    const bookingComTestPropertyId = await promptVisible(iface, 'Booking.com TEST property ID: ');
    const bookingComRoomId = await promptVisible(iface, 'Booking.com TEST room ID (positive integer): ');
    const credentialsRef = await promptVisible(iface, 'credentials_ref to store this TEST credential under: ');
    const clientId = await promptHidden('Booking.com TEST client_id (input hidden): ', { input, output });
    const clientSecret = await promptHidden('Booking.com TEST client_secret (input hidden): ', { input, output });

    const onboardingInput = {
      targetChannel: 'BOOKING_COM',
      requestedConnectionStatus: 'sandbox',
      mappingClassification: 'TEST',
      credentialEnvironment: 'TEST',
      existingRegistryStatus: null, // unknown in this offline, no-network preview — the real write path re-checks this fresh (see testAccountOnboarding.js)
      tenantId, propertyId, mappingTenantId: tenantId, mappingPropertyId: propertyId,
      credentialsRef, mappingCredentialsRef: credentialsRef,
      bookingComTestPropertyId, bookingComRoomId, roomTypeId,
      liveGates: { ariBookingComLive: false, ariOutboxDispatchEnabled: false, ariOutboxWorkerEnabled: false, ariOutboxHttpEnabled: false, channelHttpEnabled: false },
      networkExecutionRequested: false
    };

    // Proves the collected client_id/client_secret are well-formed WITHOUT
    // ever echoing them — buildTestCredentialPayload() throws on
    // empty/missing input but its error message never includes the value.
    buildTestCredentialPayload({ clientId, clientSecret });

    return { onboardingInput, plan: planOnboarding(onboardingInput) };
  } finally {
    if (!rl) iface.close();
  }
}

module.exports = { promptHidden, promptVisible, collectOnboardingInputInteractive };

// ---- manual CLI entry point (operator invocation only; never scheduled) ---
if (require.main === module) {
  console.log('QYRVIA Booking.com TEST account onboarding — DRY-RUN / PREFLIGHT ONLY (Phase 69B / instruction 050).');
  console.log('This build NEVER writes server/.env, NEVER stores a credential, and NEVER contacts Booking.com.');
  console.log('It collects your TEST identifiers locally (client_secret input is masked) and shows the exact');
  console.log('configuration PLAN that a future, separately-authorized instruction would execute — nothing is');
  console.log('written anywhere by this build. Actually wiring and running the write-mode configuration step');
  console.log('against real infrastructure is explicitly deferred to that future phase (instruction 050 Section 32).');
  console.log('');
  collectOnboardingInputInteractive({}).then(({ plan }) => {
    console.log(JSON.stringify(plan, null, 2));
    if (!plan.ok) {
      console.log('\nBLOCKED: ' + plan.reason + ' — no configuration would be written for the inputs given above.');
    } else {
      console.log('\nThis PLAN was NOT executed. No credential was stored, no registry status changed, no mapping written.');
    }
    process.exit(0);
  }).catch((e) => {
    console.error('Onboarding preflight failed: ' + (e && e.code || e && e.message || e));
    process.exit(1);
  });
}
