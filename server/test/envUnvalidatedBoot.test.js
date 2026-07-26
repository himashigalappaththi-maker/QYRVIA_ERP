'use strict';

/**
 * Phase 63 P1-3 — the production validation gate must not be silently skippable.
 *
 * validateProductionEnv only runs when NODE_ENV === 'production', and NODE_ENV
 * defaults to 'development'. A deploy that forgets to set NODE_ENV used to boot
 * with mock payments, a localhost APP_BASE_URL and no encryption-key check,
 * with nothing anywhere saying the gate had been skipped.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkUnvalidatedRemoteBoot } = require('../src/config/envValidation');

const LOCAL_DB  = 'postgres://u:p@127.0.0.1:5432/qyrvia_test';
const REMOTE_DB = 'postgres://u:p@db.internal.example.com:5432/qyrvia';

test('production boots are out of scope — the real gate already ran', () => {
  const v = checkUnvalidatedRemoteBoot({ NODE_ENV: 'production', DATABASE_URL: REMOTE_DB }, { NODE_ENV: 'production' });
  assert.equal(v.block, false);
  assert.deepEqual(v.warnings, []);
});

test('local development is never blocked', () => {
  const v = checkUnvalidatedRemoteBoot({ NODE_ENV: 'development', DATABASE_URL: LOCAL_DB }, { NODE_ENV: 'development' });
  assert.equal(v.block, false);
});

test('the test suite and CI (loopback) are never blocked', () => {
  for (const url of [
    'postgres://u:p@localhost:5432/qyrvia_test',
    'postgres://u:p@127.0.0.1:5432/qyrvia_test',
    'postgres://u:p@[::1]:5432/qyrvia_test'
  ]) {
    const v = checkUnvalidatedRemoteBoot({ NODE_ENV: 'test', DATABASE_URL: url }, { NODE_ENV: 'test' });
    assert.equal(v.block, false, url + ' must not be blocked');
  }
});

test('an unset NODE_ENV always warns that the production gate is inactive', () => {
  const v = checkUnvalidatedRemoteBoot({ NODE_ENV: 'development', DATABASE_URL: LOCAL_DB }, {});
  assert.equal(v.block, false, 'a local boot still runs');
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0], /NODE_ENV is not set/);
  assert.match(v.warnings[0], /NOT active/);
});

test('unvalidated boot against a NON-LOCAL database is REFUSED', () => {
  const v = checkUnvalidatedRemoteBoot({ NODE_ENV: 'development', DATABASE_URL: REMOTE_DB }, {});
  assert.equal(v.block, true);
  assert.match(v.reason, /NON-LOCAL host/);
  assert.match(v.reason, /Set NODE_ENV=production/);
});

test('the refusal also fires when NODE_ENV was explicitly set to a non-production value', () => {
  const v = checkUnvalidatedRemoteBoot({ NODE_ENV: 'staging', DATABASE_URL: REMOTE_DB }, { NODE_ENV: 'staging' });
  assert.equal(v.block, true);
  assert.match(v.reason, /"staging"/);
});

test('the escape hatch is explicit, opt-in, and still warns loudly', () => {
  const v = checkUnvalidatedRemoteBoot(
    { NODE_ENV: 'development', DATABASE_URL: REMOTE_DB },
    { NODE_ENV: 'development', QYRVIA_ALLOW_UNVALIDATED_REMOTE_DB: 'true' }
  );
  assert.equal(v.block, false);
  assert.ok(v.warnings.some((w) => /NON-LOCAL database/.test(w)));
});

test('a non-"true" escape-hatch value does not unlock the boot', () => {
  for (const val of ['1', 'yes', 'TRUE ', '', 'false']) {
    const v = checkUnvalidatedRemoteBoot(
      { NODE_ENV: 'development', DATABASE_URL: REMOTE_DB },
      { QYRVIA_ALLOW_UNVALIDATED_REMOTE_DB: val }
    );
    if (val === 'TRUE ') continue; // trailing space is not 'true' after lowercase — asserted below
    assert.equal(v.block, true, JSON.stringify(val) + ' must not unlock the boot');
  }
  const spaced = checkUnvalidatedRemoteBoot(
    { NODE_ENV: 'development', DATABASE_URL: REMOTE_DB },
    { QYRVIA_ALLOW_UNVALIDATED_REMOTE_DB: 'TRUE ' }
  );
  assert.equal(spaced.block, true, 'the flag is matched exactly, not fuzzily');
});

test('an unparseable DATABASE_URL is treated as non-local and refused', () => {
  const v = checkUnvalidatedRemoteBoot({ NODE_ENV: 'development', DATABASE_URL: 'not-a-url' }, {});
  assert.equal(v.block, true, 'fail closed when the host cannot be established');
});
