'use strict';

/**
 * Phase 66A-B2N-B — child-output secret redaction for the guarded database
 * commands (the migration-application wrapper "Command B" and the
 * single-file DB-test wrapper "Command C" run `require`d from the server/
 * working directory).
 *
 * A child process (the standard migration runner, or node:test running the
 * prepared DB test file) could in principle echo connection material in an
 * error path. Every captured child stdout/stderr value is therefore passed
 * through the redactor built here BEFORE being written anywhere, in this
 * exact order:
 *
 *   1. every exact occurrence of the raw connection URL
 *        -> [REDACTED_CONNECTION_STRING]
 *   2. every exact occurrence of the decoded non-empty password
 *        -> [REDACTED_PASSWORD]
 *   3. any remaining postgres:// or postgresql:// URL-shaped string
 *        -> [REDACTED_URL]
 *
 * This module never prints, logs or throws the password or URL — the
 * secrets exist only as closure values used for split/join replacement.
 * split/join (not a RegExp built from the secret) is used deliberately so
 * regex metacharacters inside a password can never break the redaction.
 */

function buildRedactor({ rawUrl, password } = {}) {
  return function redact(text) {
    let t = String(text == null ? '' : text);
    if (rawUrl && rawUrl.length > 0) {
      t = t.split(rawUrl).join('[REDACTED_CONNECTION_STRING]');
    }
    if (password && password.length > 0) {
      t = t.split(password).join('[REDACTED_PASSWORD]');
    }
    t = t.replace(/postgres(ql)?:\/\/[^\s"']+/gi, '[REDACTED_URL]');
    return t;
  };
}

module.exports = { buildRedactor };
