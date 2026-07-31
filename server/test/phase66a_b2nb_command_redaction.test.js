'use strict';

/**
 * Phase 66A-B2N-B — child-output secret redaction contract for the guarded
 * database commands (scripts/db/redactChildOutput.js).
 *
 * Proves that captured child stdout/stderr containing the full connection
 * URL, the decoded password as an isolated value, or a URL embedded in
 * surrounding text is sanitized before display — and that the redactor
 * itself never leaks either secret. No database connection, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildRedactor } = require('../scripts/db/redactChildOutput');

// Test-only fixture values — not real credentials.
const FIXTURE_PASSWORD = 'p@ss/w|rd.$^(chars)';
const FIXTURE_URL = 'postgres://qyrvia_test:' + encodeURIComponent(FIXTURE_PASSWORD) + '@127.0.0.1:5432/qyrvia_test';

const redact = buildRedactor({ rawUrl: FIXTURE_URL, password: FIXTURE_PASSWORD });

test('the full raw connection URL is replaced with [REDACTED_CONNECTION_STRING]', () => {
  const out = redact('connecting to ' + FIXTURE_URL + ' now');
  assert.ok(!out.includes(FIXTURE_URL));
  assert.match(out, /\[REDACTED_CONNECTION_STRING\]/);
});

test('the decoded password as an isolated value is replaced with [REDACTED_PASSWORD]', () => {
  const out = redact('auth failed for password "' + FIXTURE_PASSWORD + '" retrying');
  assert.ok(!out.includes(FIXTURE_PASSWORD));
  assert.match(out, /\[REDACTED_PASSWORD\]/);
});

test('a URL embedded in surrounding text (error-message style) is sanitized', () => {
  const out = redact('Error: connect ECONNREFUSED while dialing ' + FIXTURE_URL + '?\n  at Pool.connect');
  assert.ok(!out.includes('qyrvia_test:'));
  assert.ok(!out.includes(FIXTURE_PASSWORD));
});

test('a DIFFERENT postgres URL-shaped string (not the known raw URL) is still redacted as [REDACTED_URL]', () => {
  const out = redact('child printed postgresql://other:secretpw@localhost:5432/otherdb somewhere');
  assert.ok(!out.includes('secretpw'));
  assert.match(out, /\[REDACTED_URL\]/);
});

test('redaction order is exact-URL first, then password, then URL-shaped remnants', () => {
  const both = redact(FIXTURE_URL + ' and separately ' + FIXTURE_PASSWORD);
  assert.match(both, /\[REDACTED_CONNECTION_STRING\] and separately \[REDACTED_PASSWORD\]/);
});

test('regex metacharacters in the password cannot break redaction (split/join, not RegExp)', () => {
  assert.ok(FIXTURE_PASSWORD.includes('$') && FIXTURE_PASSWORD.includes('^') && FIXTURE_PASSWORD.includes('|'),
    'the fixture deliberately contains regex metacharacters');
  const out = redact('x' + FIXTURE_PASSWORD + 'y' + FIXTURE_PASSWORD + 'z');
  assert.equal(out, 'x[REDACTED_PASSWORD]y[REDACTED_PASSWORD]z');
});

test('an empty/absent password never redacts the empty string (no infinite substitution, output unchanged)', () => {
  const noPw = buildRedactor({ rawUrl: 'postgres://u@h:5432/db', password: '' });
  assert.equal(noPw('plain text'), 'plain text');
  const noneAtAll = buildRedactor({});
  assert.equal(noneAtAll('plain text'), 'plain text');
});

test('null/undefined child output is handled safely', () => {
  assert.equal(redact(null), '');
  assert.equal(redact(undefined), '');
});

test('the redactor module itself never prints or exposes secrets (no console/process.stdout use in source)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'db', 'redactChildOutput.js'), 'utf8');
  assert.ok(!/console\.|process\.stdout|process\.stderr/.test(src));
  assert.ok(!/require\(['"]pg['"]\)|http|fetch\(/.test(src), 'no database or network capability');
});
