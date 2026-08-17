'use strict';

/**
 * Phase 69B (instruction 050 Section 7) — secure LOCAL generator for a
 * CHANNEL_CREDENTIAL_KEY value in the exact format
 * src/channel-manager/credentials/cryptoBox.js's normalizeKey() accepts
 * deterministically (no passphrase-derivation ambiguity): a 64-character
 * hex string decoding to exactly 32 bytes, suitable for AES-256-GCM
 * (cryptoBox.js's ALGO).
 *
 * SAFETY PROPERTIES (each satisfied by construction):
 *   - cryptographically secure randomness -> Node's crypto.randomBytes(32)
 *     (CSPRNG), never Math.random().
 *   - adequate entropy for the CURRENT implementation -> 32 bytes = 256
 *     bits, exactly what AES-256-GCM requires and what cryptoBox.js's own
 *     32-byte-buffer / 64-hex-string branch expects with zero derivation.
 *   - never hardcoded, never committed -> generateChannelCredentialKeyHex()
 *     computes a FRESH value on every call; nothing here is a literal
 *     secret constant.
 *   - never written to out_put.txt -> this file has no awareness of, and
 *     never imports/writes to, project_bridge/ at all.
 *   - never written to stdout unless the operator explicitly invokes a
 *     dedicated local action -> printing happens ONLY in the require.main
 *     CLI branch below, and ONLY when the explicit `--print` flag is
 *     passed; requiring this module as a library NEVER prints anything.
 *   - generation is separate from ordinary unit tests/startup -> this
 *     module is never required by src/index.js or any other boot-time
 *     file; test/phase69b_generate_channel_credential_key.test.js calls
 *     generateChannelCredentialKeyHex() directly (in-process, never via a
 *     spawned CLI process) and never asserts on or logs the generated value.
 *   - no deterministic production secret generation -> uses the real
 *     CSPRNG every call; there is no seed parameter anywhere in this file.
 *
 * This script does NOT write server/.env — printing a value to the
 * operator's own terminal (when explicitly requested) is the full extent
 * of this tool; the operator decides where the value goes next.
 */

const crypto = require('crypto');

/** Fresh, cryptographically-secure 64-char hex string (32 bytes). Never deterministic, never logged by this function itself. */
function generateChannelCredentialKeyHex() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { generateChannelCredentialKeyHex };

// ---- manual CLI entry point (operator invocation only) --------------------
if (require.main === module) {
  const printRequested = process.argv.includes('--print');
  if (!printRequested) {
    console.log('QYRVIA CHANNEL_CREDENTIAL_KEY generator (Phase 69B / instruction 050).');
    console.log('This tool never writes server/.env and never prints a value unless you explicitly pass --print.');
    console.log('Run:  node generateChannelCredentialKey.js --print');
    console.log('Then copy the printed value into server/.env yourself as CHANNEL_CREDENTIAL_KEY=<value> — never paste it into chat, Git, or a command-line argument.');
    process.exit(0);
  }
  // Explicit operator action — print ONCE, to THEIR OWN terminal only.
  console.log(generateChannelCredentialKeyHex());
}
