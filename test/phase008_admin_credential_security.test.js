'use strict';

/**
 * QYRVIA-REMOVE-HARDCODED-ADMIN-CREDENTIAL-008 — narrowly scoped tests.
 *
 * Two kinds of proof, matching Continue.txt's Section 10 checklist:
 *   A. Static content assertions against the three final HTML files
 *      (no hardcoded credential, demo isolation, byte identity).
 *   B. Live execution of the actual PBKDF2/credential-storage functions,
 *      extracted verbatim from QYRVIA_ERP_V35-1.html and run in a
 *      minimal Node sandbox (Node's built-in Web Crypto + a real
 *      in-memory localStorage stub) -- not reimplemented/mocked logic.
 *
 * DOM-driven flows (button clicks, screen visibility, session-token
 * lifecycle across a page reload) are covered separately by this
 * instruction's live-browser verification, not by this file -- there is
 * no headless DOM here, deliberately, to keep this suite fast and
 * dependency-free (matches the existing qyrvia-test-ci.js convention of
 * a hand-rolled Function-sandbox rather than a browser).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROD_PATH = path.join(__dirname, '..', 'QYRVIA_ERP_V35-1.html');
const SMOKE_PATH = path.join(__dirname, '..', '..', 'QYRVIA_UI_SMOKETEST', 'index.html');
const DEMO_PATH = path.join(__dirname, '..', '..', 'QYRVIA_STANDALONE_DEMO', 'index.html');

const prodHtml = fs.readFileSync(PROD_PATH, 'utf8');
const smokeHtml = fs.readFileSync(SMOKE_PATH, 'utf8');
const demoHtml = fs.readFileSync(DEMO_PATH, 'utf8');

// ── A. Static content assertions ───────────────────────────────────────

test('A1: former hardcoded local-admin default password has zero matches in all three files', () => {
  for (const html of [prodHtml, smokeHtml, demoHtml]) {
    assert.equal((html.match(/Wpcad1742@/g) || []).length, 0);
  }
});

test('A2: former hardcoded super-admin default password has zero matches in all three files', () => {
  for (const html of [prodHtml, smokeHtml, demoHtml]) {
    assert.equal((html.match(/GK@SaaS2025!/g) || []).length, 0);
  }
});

test('A3: DEFAULT_ADMIN_PWD/checkAdminPassword/getAdminPassword/getSuperAdminCreds no longer exist', () => {
  for (const name of ['DEFAULT_ADMIN_PWD', 'checkAdminPassword', 'getAdminPassword', 'getSuperAdminCreds']) {
    assert.equal((prodHtml.match(new RegExp(name, 'g')) || []).length, 0, name + ' should be fully removed');
  }
});

test('A4: no plaintext admin123 default remains in either loadUsers seed', () => {
  assert.equal((prodHtml.match(/password\s*:\s*['"]admin123['"]/g) || []).length, 0);
});

test('A5: the legacy "gk_admin_pwd" key name is retained only as a migration-source constant, not a live default', () => {
  const idx = prodHtml.indexOf("ADMIN_PWD_KEY='gk_admin_pwd'");
  assert.ok(idx >= 0, 'the key-name constant should still exist, for one-time legacy migration/cleanup only');
  // It must only ever be used with removeItem (cleanup), never setItem with a fixed value.
  assert.equal((prodHtml.match(/localStorage\.setItem\(ADMIN_PWD_KEY/g) || []).length, 0);
});

test('A6: production and smoketest contain no demo-entry bypass (qyEnterDemo)', () => {
  assert.equal((prodHtml.match(/qyEnterDemo/g) || []).length, 0);
  assert.equal((smokeHtml.match(/qyEnterDemo/g) || []).length, 0);
});

test('A7: the standalone demo contains its explicit demo-only entry mechanism and marker', () => {
  assert.ok(demoHtml.includes('function qyEnterDemo()'));
  assert.ok(demoHtml.includes("window.QY_RUNTIME_MODE = 'standalone-demo';"));
});

test('A8: the demo-only marker does not exist in production or smoketest', () => {
  assert.equal((prodHtml.match(/QY_RUNTIME_MODE\s*=\s*'standalone-demo'/g) || []).length, 0);
  assert.equal((smokeHtml.match(/QY_RUNTIME_MODE\s*=\s*'standalone-demo'/g) || []).length, 0);
});

test('A9: demo cannot configure a production backend (_isBackendAdmin forced false in the demo copy only)', () => {
  assert.ok(demoHtml.includes('const _isBackendAdmin = () => false;'));
  assert.equal((prodHtml.match(/const _isBackendAdmin = \(\) => false;/g) || []).length, 0);
});

test('A10: production smoketest is byte-identical to production', () => {
  assert.equal(smokeHtml, prodHtml);
});

test('A11: Patrol Point Location and Incident Report (Security-only) markup remains intact in production', () => {
  assert.ok(prodHtml.includes('id="spAddPointBtnHost"'));
  assert.ok(prodHtml.includes('id="nav-incidents-sec"'));
  assert.ok(!/id="nav-incidents"[^-]/.test(prodHtml.replace(/id="nav-incidents-sec"/g, '')));
});

test('A12: backend-connected V26 login never references the local admin credential store', () => {
  const start = prodHtml.indexOf('const _doLogin = async () => {');
  const end = prodHtml.indexOf('const openHealth', start);
  assert.ok(start > 0 && end > start, 'could not locate the V26 backend _doLogin function');
  const body = prodHtml.slice(start, end);
  assert.ok(!body.includes('qyVerifyAdminPassword'));
  assert.ok(!body.includes('gk_admin_auth'));
});

// ── B. Live execution of the extracted PBKDF2/credential functions ─────

function extractBetween(html, startMarker, endMarker) {
  const s = html.indexOf(startMarker);
  assert.ok(s >= 0, 'start marker not found: ' + startMarker);
  const e = html.indexOf(endMarker, s);
  assert.ok(e > s, 'end marker not found after start: ' + endMarker);
  return html.slice(s, e);
}

// Pull the real ADMIN PASSWORD block (crypto helpers + credential CRUD +
// legacy migration + changeAdminPassword) and the loadUsers/saveUsers
// pair it depends on, verbatim out of the actual production file.
const adminPasswordSrc = extractBetween(
  prodHtml,
  "const ADMIN_PWD_KEY='gk_admin_pwd';",
  '// VOID'
);
const loadUsersSrc = extractBetween(
  prodHtml,
  'function loadUsers(){',
  "function saveUsers(users){localStorage.setItem('gk_users',JSON.stringify(users));}"
) + "function saveUsers(users){localStorage.setItem('gk_users',JSON.stringify(users));}";

function makeSandbox() {
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    key: (i) => Object.keys(store)[i] || null,
    get length() { return Object.keys(store).length; },
  };
  const toastCalls = [];
  const sandbox = {
    localStorage,
    crypto, // Node's global Web Crypto (webcrypto), same API surface as the browser
    btoa, atob,
    toast: (msg, kind) => { toastCalls.push({ msg, kind }); },
    document: { getElementById: () => null },
    console,
  };
  const fn = new Function(
    'localStorage', 'crypto', 'btoa', 'atob', 'toast', 'document', 'console',
    loadUsersSrc + '\n' + adminPasswordSrc + '\n' +
    'return { qyRandomSaltB64, qyDeriveVerifier, qyConstantTimeEqual, qyGetAdminAuth, ' +
    'qySetAdminAuth, qyCreateAdminCredential, qyVerifyAdminPassword, qyPasswordPolicyErrors, ' +
    'qyIsAdminSetupNeeded, _qyLegacyAdminPlaintextUser, qyTryLegacyAdminMigration, loadUsers, saveUsers };'
  );
  const api = fn(sandbox.localStorage, sandbox.crypto, sandbox.btoa, sandbox.atob, sandbox.toast, sandbox.document, sandbox.console);
  return { api, store, toastCalls };
}

test('B1: fresh state -- Administrator Setup is needed (no credential, no legacy plaintext)', () => {
  const { api } = makeSandbox();
  assert.equal(api.qyIsAdminSetupNeeded(), true);
  assert.equal(api.qyGetAdminAuth(), null);
});

test('B2: password policy rejects weak passwords and accepts a strong one', () => {
  const { api } = makeSandbox();
  assert.ok(api.qyPasswordPolicyErrors('short1!').length > 0, 'too short');
  assert.ok(api.qyPasswordPolicyErrors('alllowercase123!').length > 0, 'no uppercase');
  assert.ok(api.qyPasswordPolicyErrors('ALLUPPERCASE123!').length > 0, 'no lowercase');
  assert.ok(api.qyPasswordPolicyErrors('NoDigitsHereEither!').length > 0, 'no number');
  assert.ok(api.qyPasswordPolicyErrors('NoSpecialChar123').length > 0, 'no special character');
  assert.deepEqual(api.qyPasswordPolicyErrors('Str0ng!Passw0rd'), []);
});

test('B3: two salts generated back-to-back are unique', () => {
  const { api } = makeSandbox();
  const a = api.qyRandomSaltB64(16);
  const b = api.qyRandomSaltB64(16);
  assert.notEqual(a, b);
});

test('B4: creating a credential stores only username/salt/verifier/algo metadata -- never the plaintext password', async () => {
  const { api, store } = makeSandbox();
  const password = 'Str0ng!Passw0rd';
  await api.qyCreateAdminCredential('admin', password);
  const raw = store['gk_admin_auth'];
  assert.ok(raw, 'gk_admin_auth should be written');
  assert.ok(!raw.includes(password), 'the raw plaintext password must never appear in the stored record');
  const rec = JSON.parse(raw);
  assert.deepEqual(Object.keys(rec).sort(), ['algo', 'iterations', 'salt', 'setupAt', 'username', 'v', 'verifier'].sort());
  assert.equal(rec.algo, 'PBKDF2-SHA256');
  assert.ok(rec.iterations >= 310000);
  // Also confirm no OTHER localStorage key holds the plaintext either.
  for (const k of Object.keys(store)) {
    assert.ok(!store[k].includes(password), 'plaintext password leaked into key: ' + k);
  }
});

test('B5: after setup, the correct password verifies and Administrator Setup is no longer needed', async () => {
  const { api } = makeSandbox();
  await api.qyCreateAdminCredential('admin', 'Str0ng!Passw0rd');
  assert.equal(api.qyIsAdminSetupNeeded(), false);
  assert.equal(await api.qyVerifyAdminPassword('Str0ng!Passw0rd'), true);
});

test('B6: an incorrect password is rejected after setup', async () => {
  const { api } = makeSandbox();
  await api.qyCreateAdminCredential('admin', 'Str0ng!Passw0rd');
  assert.equal(await api.qyVerifyAdminPassword('WrongPassword1!'), false);
});

test('B7: the former hardcoded global default is never accepted, even after setup', async () => {
  const { api } = makeSandbox();
  await api.qyCreateAdminCredential('admin', 'Str0ng!Passw0rd');
  assert.equal(await api.qyVerifyAdminPassword('Wpcad1742@'), false);
});

test('B8: before any setup, no password (including the former default) verifies -- fails closed', async () => {
  const { api } = makeSandbox();
  assert.equal(await api.qyVerifyAdminPassword('Wpcad1742@'), false);
  assert.equal(await api.qyVerifyAdminPassword('admin123'), false);
  assert.equal(await api.qyVerifyAdminPassword(''), false);
});

test('B9: changing the credential (new salt+verifier) invalidates the previous password', async () => {
  const { api } = makeSandbox();
  await api.qyCreateAdminCredential('admin', 'Str0ng!Passw0rd');
  const saltBefore = api.qyGetAdminAuth().salt;
  await api.qyCreateAdminCredential('admin', 'AnotherStr0ng!Pass');
  assert.notEqual(api.qyGetAdminAuth().salt, saltBefore, 'a new salt should be generated on change');
  assert.equal(await api.qyVerifyAdminPassword('Str0ng!Passw0rd'), false, 'old password must no longer work');
  assert.equal(await api.qyVerifyAdminPassword('AnotherStr0ng!Pass'), true, 'new password must work');
});

test('B10: legacy plaintext migration converts a pre-008 gk_users password and removes it, without ever exposing it', async () => {
  const { api, store } = makeSandbox();
  // Simulate a pre-upgrade install: gk_users has a real plaintext admin password.
  store['gk_users'] = JSON.stringify([{ id: 'u1', name: 'Administrator', username: 'admin', role: 'admin', password: 'OldRealPassw0rd!', tempPwd: false }]);
  assert.equal(api.qyIsAdminSetupNeeded(), false, 'a legacy plaintext account should NOT show Setup Required');
  const migrated = await api.qyTryLegacyAdminMigration('admin', 'OldRealPassw0rd!');
  assert.ok(migrated, 'migration should succeed for the correct legacy password');
  assert.ok(api.qyGetAdminAuth(), 'a PBKDF2 credential should now exist');
  const usersAfter = JSON.parse(store['gk_users']);
  assert.equal(usersAfter.find(u => u.id === 'u1').password, undefined, 'plaintext password field must be deleted after migration');
  assert.equal(await api.qyVerifyAdminPassword('OldRealPassw0rd!'), true, 'the migrated password verifies via the new scheme');
});

test('B11: legacy migration never fires once a PBKDF2 credential already exists', async () => {
  const { api, store } = makeSandbox();
  await api.qyCreateAdminCredential('admin', 'Str0ng!Passw0rd');
  store['gk_users'] = JSON.stringify([{ id: 'u1', name: 'Administrator', username: 'admin', role: 'admin', password: 'admin123', tempPwd: false }]);
  const result = await api.qyTryLegacyAdminMigration('admin', 'admin123');
  assert.equal(result, null, 'must not silently accept a leftover plaintext value once real setup has happened');
});

test('B12: a fresh loadUsers() seed carries no password field for the bootstrap admin', () => {
  const { api } = makeSandbox();
  const users = api.loadUsers();
  const u1 = users.find(u => u.id === 'u1');
  assert.ok(u1);
  assert.equal(u1.password, undefined);
  assert.equal(u1.tempPwd, false);
});
