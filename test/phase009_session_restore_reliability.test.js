'use strict';

/**
 * QYRVIA-SESSION-RESTORE-RELIABILITY-009 — narrowly scoped tests.
 *
 * Two kinds of proof, matching Continue.txt's Section 4 checklist:
 *   A. Live execution of the actual session-validation/restoration
 *      functions, extracted verbatim from QYRVIA_ERP_V35-1.html and run
 *      in a minimal Node sandbox (real in-memory sessionStorage/
 *      localStorage/document stubs) -- not reimplemented logic.
 *   B. Live execution of the actual doLogin() wrapper IIFEs (audit
 *      logging, session tracking, GK_V24 brute-force tracking),
 *      verifying each correctly awaits a controllable-delay fake login
 *      before classifying the result as success/failure, instead of
 *      guessing with a fixed timeout.
 *
 * Full-DOM flows (dashboard becoming visible, DOMContentLoaded ordering,
 * a real hard page reload) are covered separately by this instruction's
 * live-browser verification, not by this file.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROD_PATH = path.join(__dirname, '..', 'QYRVIA_ERP_V35-1.html');
const prodHtml = fs.readFileSync(PROD_PATH, 'utf8');

function extractBetween(html, startMarker, endMarker) {
  const s = html.indexOf(startMarker);
  assert.ok(s >= 0, 'start marker not found: ' + startMarker);
  const e = html.indexOf(endMarker, s);
  assert.ok(e > s, 'end marker not found after start: ' + endMarker);
  return html.slice(s, e);
}

// ── A. Session validation/restoration ───────────────────────────────────

const loadUsersSrc = extractBetween(
  prodHtml,
  'function loadUsers(){',
  "function saveUsers(users){localStorage.setItem('gk_users',JSON.stringify(users));}"
) + "function saveUsers(users){localStorage.setItem('gk_users',JSON.stringify(users));}";

const sessionRestoreSrc = extractBetween(
  prodHtml,
  'const QY_SESSION_MAX_AGE_MS=8*60*60*1000;',
  '(function checkSession(){'
);

function makeSessionSandbox() {
  const localStore = {};
  const sessionStore = {};
  const localStorage = {
    getItem: (k) => (k in localStore ? localStore[k] : null),
    setItem: (k, v) => { localStore[k] = String(v); },
    removeItem: (k) => { delete localStore[k]; },
  };
  const sessionStorage = {
    getItem: (k) => (k in sessionStore ? sessionStore[k] : null),
    setItem: (k, v) => { sessionStore[k] = String(v); },
    removeItem: (k) => { delete sessionStore[k]; },
  };
  const AUTH = { user: null };
  const elements = {};
  function fakeEl() { return { style: { display: '' } }; }
  ['loginScreen', 'adminSetupScreen'].forEach(id => { elements[id] = fakeEl(); });
  const document = {
    readyState: 'complete', // most tests exercise the "DOM already ready" branch directly
    getElementById: (id) => elements[id] || null,
    addEventListener: () => { throw new Error('DOMContentLoaded path not expected in this test'); },
  };
  const consoleErrors = [];
  const fakeConsole = { error: (...args) => consoleErrors.push(args), warn: () => {}, log: () => {} };
  let applyRoleUICalls = 0;
  let applyRoleUIShouldThrow = false;
  const applyRoleUI = () => {
    applyRoleUICalls++;
    if (applyRoleUIShouldThrow) throw new Error('simulated DOM-not-ready failure');
  };
  const fn = new Function(
    'localStorage', 'sessionStorage', 'AUTH', 'document', 'console', 'applyRoleUI', 'init',
    loadUsersSrc + '\n' + sessionRestoreSrc + '\n' +
    'return { _qyValidateStoredSession, _qyApplyRestoredSession, loadUsers, saveUsers };'
  );
  const api = fn(localStorage, sessionStorage, AUTH, document, fakeConsole, () => applyRoleUI(), () => {});
  return {
    api, localStore, sessionStore, AUTH, elements, consoleErrors,
    setThrow: (v) => { applyRoleUIShouldThrow = v; },
    getApplyRoleUICalls: () => applyRoleUICalls,
  };
}

function seedValidSession(sb, overrides) {
  sb.localStore['gk_users'] = JSON.stringify([{ id: 'u1', name: 'Administrator', username: 'admin', role: 'admin', tempPwd: false }]);
  sb.sessionStore['gk_session'] = JSON.stringify(Object.assign({ id: 'u1', username: 'admin', role: 'admin', name: 'Administrator', startedAt: Date.now() }, overrides || {}));
}

test('A1: a valid, freshly-started session validates successfully', () => {
  const sb = makeSessionSandbox();
  seedValidSession(sb);
  const user = sb.api._qyValidateStoredSession();
  assert.ok(user);
  assert.equal(user.id, 'u1');
});

test('A2: applying a restored session hides the login/setup screens and sets AUTH.user', () => {
  const sb = makeSessionSandbox();
  seedValidSession(sb);
  const user = sb.api._qyValidateStoredSession();
  sb.api._qyApplyRestoredSession(user);
  assert.equal(sb.AUTH.user.id, 'u1');
  assert.equal(sb.elements.loginScreen.style.display, 'none');
  assert.equal(sb.elements.adminSetupScreen.style.display, 'none');
});

test('A3: an applyRoleUI() timing failure does not destroy a valid session or reopen the login screen', () => {
  const sb = makeSessionSandbox();
  seedValidSession(sb);
  sb.setThrow(true);
  const user = sb.api._qyValidateStoredSession();
  assert.ok(user, 'session must still validate');
  // Must not throw out of _qyApplyRestoredSession even though applyRoleUI() does.
  assert.doesNotThrow(() => sb.api._qyApplyRestoredSession(user));
  assert.equal(sb.AUTH.user.id, 'u1', 'AUTH.user must remain set despite the UI failure');
  assert.equal(sb.elements.loginScreen.style.display, 'none', 'login screen must stay hidden, not reopened');
  assert.equal(sb.consoleErrors.length, 1, 'the failure must be logged, not silently swallowed');
  assert.match(sb.consoleErrors[0][0], /applyRoleUI/);
});

test('A4: an expired session (older than the 8h bound) fails closed and is discarded', () => {
  const sb = makeSessionSandbox();
  seedValidSession(sb, { startedAt: Date.now() - (9 * 60 * 60 * 1000) });
  const user = sb.api._qyValidateStoredSession();
  assert.equal(user, null);
  assert.equal(sb.sessionStore['gk_session'], undefined, 'expired session must be removed from storage');
});

test('A5: a malformed session (invalid JSON) fails closed and is discarded', () => {
  const sb = makeSessionSandbox();
  sb.sessionStore['gk_session'] = '{not valid json';
  const user = sb.api._qyValidateStoredSession();
  assert.equal(user, null);
  assert.equal(sb.sessionStore['gk_session'], undefined);
});

test('A6: a malformed session (missing id) fails closed and is discarded', () => {
  const sb = makeSessionSandbox();
  sb.sessionStore['gk_session'] = JSON.stringify({ username: 'admin', startedAt: Date.now() });
  const user = sb.api._qyValidateStoredSession();
  assert.equal(user, null);
  assert.equal(sb.sessionStore['gk_session'], undefined);
});

test('A7: a forged session pointing at a non-existent user id fails closed', () => {
  const sb = makeSessionSandbox();
  sb.localStore['gk_users'] = JSON.stringify([{ id: 'u1', name: 'Administrator', username: 'admin', role: 'admin' }]);
  sb.sessionStore['gk_session'] = JSON.stringify({ id: 'does-not-exist', username: 'ghost', startedAt: Date.now() });
  const user = sb.api._qyValidateStoredSession();
  assert.equal(user, null, 'a session with no matching credential must never authenticate');
  assert.equal(sb.sessionStore['gk_session'], undefined, 'the forged session must be discarded');
});

test('A8: no stored session at all validates to null (fresh state, no automatic login)', () => {
  const sb = makeSessionSandbox();
  const user = sb.api._qyValidateStoredSession();
  assert.equal(user, null);
});

test('A9: logout (session removed) means the next validation fails closed', () => {
  const sb = makeSessionSandbox();
  seedValidSession(sb);
  assert.ok(sb.api._qyValidateStoredSession());
  // Simulate what doLogout()/_qyForceReauth() does: clear the session.
  delete sb.sessionStore['gk_session'];
  assert.equal(sb.api._qyValidateStoredSession(), null);
});

test('A10: password change invalidating the session means the next validation fails closed', () => {
  const sb = makeSessionSandbox();
  seedValidSession(sb);
  assert.ok(sb.api._qyValidateStoredSession());
  // Simulate changeAdminPassword()'s forced re-auth: session cleared.
  delete sb.sessionStore['gk_session'];
  sb.AUTH.user = null;
  assert.equal(sb.api._qyValidateStoredSession(), null);
  assert.equal(sb.AUTH.user, null);
});

// ── B. doLogin() wrapper timing correctness ─────────────────────────────

const auditWrapperSrc = extractBetween(
  prodHtml,
  '// Patch doLogin to audit logins.',
  '// Patch doLogout to audit logouts'
);
const sessionTrackingWrapperSrc = extractBetween(
  prodHtml,
  '// Patch doLogin for session tracking.',
  '// Patch doLogout for session tracking'
);
const bruteForceWrapperSrc = extractBetween(
  prodHtml,
  '// ── Patch 1: Login',
  '// ── Patch 2: Logout'
);

// A fake "real" doLogin with a controllable delay and outcome, standing
// in for the actual PBKDF2-backed implementation -- proves the wrapper
// correctly observes whichever result arrives, on whatever timeline,
// rather than assuming a fixed delay.
function makeFakeCoreLogin(AUTH, { delayMs, succeeds }) {
  return function fakeDoLogin() {
    return new Promise((resolve) => {
      setTimeout(() => {
        if (succeeds) AUTH.user = { id: 'u1', name: 'Administrator', role: 'admin' };
        else AUTH.user = null;
        resolve();
      }, delayMs);
    });
  };
}

test('B1: audit-logging wrapper logs success only when the (slow) login actually succeeds', async () => {
  const AUTH = { user: null };
  const auditCalls = [];
  const auditLog = (...args) => auditCalls.push(args);
  global.window = { doLogin: makeFakeCoreLogin(AUTH, { delayMs: 60, succeeds: true }), AUTH };
  global.AUTH = AUTH;
  global.auditLog = auditLog;
  try {
    const fn = new Function('window', 'AUTH', 'auditLog', auditWrapperSrc);
    fn(global.window, AUTH, auditLog);
    await global.window.doLogin();
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0][0], 'login');
  } finally {
    delete global.window; delete global.AUTH; delete global.auditLog;
  }
});

test('B2: audit-logging wrapper logs nothing when the (slow) login fails', async () => {
  const AUTH = { user: null };
  const auditCalls = [];
  const auditLog = (...args) => auditCalls.push(args);
  global.window = { doLogin: makeFakeCoreLogin(AUTH, { delayMs: 60, succeeds: false }), AUTH };
  global.AUTH = AUTH;
  global.auditLog = auditLog;
  try {
    const fn = new Function('window', 'AUTH', 'auditLog', auditWrapperSrc);
    fn(global.window, AUTH, auditLog);
    await global.window.doLogin();
    assert.equal(auditCalls.length, 0, 'a failed login must not produce a login-success audit entry');
  } finally {
    delete global.window; delete global.AUTH; delete global.auditLog;
  }
});

test('B3: session-tracking wrapper starts a session only on real success, regardless of delay', async () => {
  const AUTH = { user: null };
  const tracked = [];
  global.window = { doLogin: makeFakeCoreLogin(AUTH, { delayMs: 80, succeeds: true }), AUTH };
  global.AUTH = AUTH;
  global.erpTrackSession = (evt) => tracked.push(evt);
  try {
    const fn = new Function('window', 'AUTH', 'erpTrackSession', sessionTrackingWrapperSrc);
    fn(global.window, AUTH, global.erpTrackSession);
    await global.window.doLogin();
    assert.deepEqual(tracked, ['start']);
  } finally {
    delete global.window; delete global.AUTH; delete global.erpTrackSession;
  }
});

test('B4: session-tracking wrapper does not start a session on failure, regardless of delay', async () => {
  const AUTH = { user: null };
  const tracked = [];
  global.window = { doLogin: makeFakeCoreLogin(AUTH, { delayMs: 80, succeeds: false }), AUTH };
  global.AUTH = AUTH;
  global.erpTrackSession = (evt) => tracked.push(evt);
  try {
    const fn = new Function('window', 'AUTH', 'erpTrackSession', sessionTrackingWrapperSrc);
    fn(global.window, AUTH, global.erpTrackSession);
    await global.window.doLogin();
    assert.deepEqual(tracked, []);
  } finally {
    delete global.window; delete global.AUTH; delete global.erpTrackSession;
  }
});

function makeBruteForceSandbox(AUTH, delayMs, succeeds) {
  const trackCalls = [];
  const auditCalls = [];
  let sessionStarted = null;
  const GK_V24 = {
    security: {
      isLoginLocked: () => false,
      trackLoginAttempt: (u, ok) => trackCalls.push([u, ok]),
    },
    auth: { startSession: (u) => { sessionStarted = u; } },
    audit: { log: (...a) => auditCalls.push(a) },
  };
  const elements = { loginUser: { value: 'testadmin' }, loginPass: { value: 'irrelevant' } };
  const document = { getElementById: (id) => elements[id] || null };
  global.window = { doLogin: makeFakeCoreLogin(AUTH, { delayMs, succeeds }) };
  global.AUTH = AUTH;
  global.GK_V24 = GK_V24;
  global.document = document;
  global.toast = () => {};
  return { trackCalls, auditCalls, getSessionStarted: () => sessionStarted };
}

test('B5: GK_V24 brute-force wrapper records success (and starts a session) only after the real slow login succeeds', async () => {
  const AUTH = { user: null };
  const sb = makeBruteForceSandbox(AUTH, 90, true);
  try {
    const fn = new Function('window', 'AUTH', 'GK_V24', 'document', 'toast', bruteForceWrapperSrc);
    fn(global.window, AUTH, global.GK_V24, global.document, global.toast);
    await global.window.doLogin();
    assert.deepEqual(sb.trackCalls, [['testadmin', true]]);
    assert.ok(sb.getSessionStarted(), 'a successful login must start a GK_V24 session');
  } finally {
    delete global.window; delete global.AUTH; delete global.GK_V24; delete global.document; delete global.toast;
  }
});

test('B6: GK_V24 brute-force wrapper records failure (and does not start a session) after the real slow login fails', async () => {
  const AUTH = { user: null };
  const sb = makeBruteForceSandbox(AUTH, 90, false);
  try {
    const fn = new Function('window', 'AUTH', 'GK_V24', 'document', 'toast', bruteForceWrapperSrc);
    fn(global.window, AUTH, global.GK_V24, global.document, global.toast);
    await global.window.doLogin();
    assert.deepEqual(sb.trackCalls, [['testadmin', false]]);
    assert.equal(sb.getSessionStarted(), null, 'a failed login must never start a session');
  } finally {
    delete global.window; delete global.AUTH; delete global.GK_V24; delete global.document; delete global.toast;
  }
});

test('B7: none of the three wrapper sources contain a fixed-delay setTimeout guessing the login result', () => {
  for (const src of [auditWrapperSrc, sessionTrackingWrapperSrc, bruteForceWrapperSrc]) {
    assert.ok(!/setTimeout\(/.test(src), 'wrapper must await the real result, not guess with setTimeout');
    assert.ok(/await _or?ig\.apply|await _oLogin\.apply/.test(src), 'wrapper must await the wrapped login call');
  }
});

test('B8: no credential (password/verifier/salt/token) is ever passed to auditLog/GK_V24 logging calls', () => {
  // Static proof by source inspection: every logging call in the three
  // wrappers passes only name/role/username -- `passEl` (the password
  // input reference) is read in the brute-force wrapper only to decide
  // lockout by username, never forwarded to any log/audit call.
  assert.ok(!/auditLog\([^)]*passEl/i.test(auditWrapperSrc));
  assert.ok(!/erpTrackSession\([^)]*passEl/i.test(sessionTrackingWrapperSrc));
  assert.ok(!/GK_V24\.audit\.log\([^)]*passEl/i.test(bruteForceWrapperSrc));
  assert.ok(!/trackLoginAttempt\([^)]*passEl\.value/i.test(bruteForceWrapperSrc));
});
