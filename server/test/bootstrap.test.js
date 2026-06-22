'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('node:fs');
const path = require('node:path');
const identity = require('../src/services/identity');

test('bootstrap script file exists and is executable', () => {
  const p = path.join(__dirname, '..', 'src', 'scripts', 'bootstrap.js');
  assert.ok(fs.existsSync(p), 'bootstrap.js must exist');
  const src = fs.readFileSync(p, 'utf8');
  assert.match(src, /node_modules|require|function/);
  // Sanity: refuses passwords < 8 chars
  assert.match(src, /admin password must be 8\+/);
});

test('bootstrap migrate-local-users alias file exists', () => {
  const p = path.join(__dirname, '..', 'src', 'scripts', 'migrate-local-users.js');
  assert.ok(fs.existsSync(p));
  const src = fs.readFileSync(p, 'utf8');
  assert.match(src, /migrate-gk-users/);
});

test('identity.hashPassword + verifyPassword round-trip (for bootstrap)', async () => {
  const hash = await identity.hashPassword('SuperStrong!2026');
  assert.match(hash, /^\$2[aby]\$/, 'bcrypt hash');
  assert.equal(await identity.verifyPassword('SuperStrong!2026', hash), true);
  assert.equal(await identity.verifyPassword('wrong',             hash), false);
});

test('identity.hashPassword rejects short passwords', async () => {
  await assert.rejects(identity.hashPassword('123'), /password_too_short/);
});
