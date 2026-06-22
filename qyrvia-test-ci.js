#!/usr/bin/env node
/*
  QYRVIA ERP - CI Test Runner
  ----------------------------------------------------------------------
  Loads QYRVIA_ERP_V35-1.html, isolates the QYRVIA_CORE script blocks,
  executes them with a minimal browser shim, runs QYRVIA_TESTS.runAll(),
  and prints a summary + per-test report. Exit code: 0 on all-pass, 1 on
  any failure.

  Usage:
    node qyrvia-test-ci.js                     # default: run all suites
    node qyrvia-test-ci.js --suite=periods     # run one suite
    node qyrvia-test-ci.js --json              # machine-readable output
    node qyrvia-test-ci.js --tap               # TAP output for CI
    node qyrvia-test-ci.js --file=path.html    # alternate HTML file

  No npm dependencies; pure Node stdlib.
*/
'use strict';

const fs = require('fs');
const path = require('path');

// ── args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).reduce((m, a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  m[k] = v === undefined ? true : v;
  return m;
}, {});

const HTML_PATH = args.file || path.join(__dirname, 'QYRVIA_ERP_V35-1.html');
const FORMAT    = args.tap ? 'tap' : (args.json ? 'json' : 'pretty');
const SUITE     = args.suite || null;

// ── load + isolate the QYRVIA_CORE blocks ──────────────────────────────
if (!fs.existsSync(HTML_PATH)) {
  console.error('FATAL: file not found: ' + HTML_PATH);
  process.exit(2);
}
const html = fs.readFileSync(HTML_PATH, 'utf8');
const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (blocks.length < 4) {
  console.error('FATAL: expected QYRVIA_CORE blocks at end of file - found only ' + blocks.length + ' script blocks');
  process.exit(2);
}

// Find QYRVIA framework blocks by their distinctive comment header.
// All framework blocks open with a banner like:
//   QYRVIA ERP V35 - ENTERPRISE CORE FRAMEWORK
//   QYRVIA ERP V35 - ENTERPRISE CORE EXTENSIONS [PASS N]
//   QYRVIA ERP V35 - FIRST-BOOT SETUP WIZARD
const coreBlocks = blocks.filter(src =>
  /QYRVIA ERP V35 - (ENTERPRISE CORE|FIRST-BOOT SETUP|SETUP WIZARD)/.test(src)
);
if (coreBlocks.length < 1) {
  console.error('FATAL: no QYRVIA framework blocks found in HTML');
  process.exit(2);
}

// ── browser shim ──────────────────────────────────────────────────────
const w = {
  AUTH: { user: { id: 'sys', name: 'System', role: 'admin' }, currentProperty: 'p1' },
  PAGE_MAP: {}, PAGE_TITLES: {},
  showPage: function () {}, _save: function () {}, _toast: function () {},
  _user: function () { return this.AUTH.user; },
  fetch: async function () { return { ok: false, status: 599, json: async () => ({}) }; },
  prompt: () => null, confirm: () => true, alert: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  setInterval: setInterval, clearInterval: clearInterval,
  location: { href: 'file://qyrvia-ci', pathname: '/' },
  navigator: { userAgent: 'qyrvia-ci' },
  console: console
};
w.window = w;

const _storage = {};
const localStorage = {
  getItem: k => (k in _storage) ? _storage[k] : null,
  setItem: (k, v) => { _storage[k] = String(v); },
  removeItem: k => { delete _storage[k]; }
};

const document = {
  readyState: 'complete',
  getElementById: () => null,
  createElement: () => ({ appendChild: () => {}, setAttribute: () => {}, style: {}, classList: { add: () => {} }, addEventListener: () => {} }),
  querySelector: () => null,
  body: { appendChild: () => {} },
  head: { appendChild: () => {} },
  addEventListener: () => {}
};

const DB = {
  employees: [], inventory: [{ code: 'TEST-ITEM', qty: 10 }], grn: [],
  qyAuditLog: [], aiAuditLog: [],
  leaveRequests: [], payrollRuns: [], stockAdjustments: [], purchaseOrders: [],
  rateOverrides: [], reviewReplies: [], guestMerges: [], guests: [],
  qyClosedPeriods: [], journalEntries: [], qyAcceptance: {}
};

// Enterprise DB stubs (used by AP payment / AR invoice helpers)
const _entDB = {
  ar: { invoices: [] },
  ap: { invoices: [{ id: 'INV1', amount: 1000, paid: 0, status: 'pending' }], payments: [] }
};
const entLoadDB = () => _entDB;
const entSaveDB = () => {};

// Expose globals the framework reads off the host
global.window = w;
global.document = document;
global.localStorage = localStorage;
global.DB = DB;
global.AUTH = w.AUTH;
global._user = w._user;
global._save = w._save;
global._toast = w._toast;
global.fetch = w.fetch;
global.entLoadDB = entLoadDB;
global.entSaveDB = entSaveDB;
w.entLoadDB = entLoadDB;
w.entSaveDB = entSaveDB;

// ── execute each block in a Function-wrapped sandbox ───────────────────
function exec(src, label) {
  try {
    const fn = new Function('window', 'document', 'localStorage', 'DB', 'AUTH', 'fetch', '_user', '_save', '_toast', 'global', src);
    fn(w, document, localStorage, DB, w.AUTH, w.fetch, w._user, w._save, w._toast, global);
  } catch (e) {
    console.error('FATAL: failed to load ' + label + ': ' + e.message);
    process.exit(2);
  }
}

// Suppress framework + test-induced console noise unless --verbose
const realConsoleLog = console.log.bind(console);
const realConsoleGroup    = (console.group    || function(){}).bind(console);
const realConsoleGroupEnd = (console.groupEnd || function(){}).bind(console);
let muteFrameworkLogs = !args.verbose;
console.log = function () {
  if (muteFrameworkLogs) return;
  realConsoleLog.apply(console, arguments);
};
console.group    = function () { if (!muteFrameworkLogs) realConsoleGroup.apply(console, arguments); };
console.groupEnd = function () { if (!muteFrameworkLogs) realConsoleGroupEnd.apply(console, arguments); };

coreBlocks.forEach((src, i) => exec(src, 'QYRVIA_CORE block #' + (i + 1)));

if (!w.QYRVIA_TESTS) {
  console.error('FATAL: QYRVIA_TESTS not loaded after executing core blocks');
  process.exit(2);
}

// ── run ────────────────────────────────────────────────────────────────
(async () => {
  let report;
  try {
    report = await w.QYRVIA_TESTS.runAll();
  } catch (e) {
    console.error('FATAL: runAll threw: ' + e.message);
    process.exit(2);
  }

  let results = report.results;
  if (SUITE) results = results.filter(r => r.suite === SUITE);
  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;

  // From here on, the runner is producing the report - re-enable console.log
  muteFrameworkLogs = false;
  console.log = realConsoleLog;

  if (FORMAT === 'json') {
    console.log(JSON.stringify({
      file: HTML_PATH,
      ranAt: report.ranAt,
      total: results.length,
      passed: passed,
      failed: failed,
      results: results
    }, null, 2));
  } else if (FORMAT === 'tap') {
    console.log('TAP version 13');
    console.log('1..' + results.length);
    results.forEach((r, i) => {
      console.log((r.ok ? 'ok ' : 'not ok ') + (i + 1) + ' - ' + r.suite + '/' + r.name + ' (' + r.ms + 'ms)');
      if (!r.ok) {
        console.log('  ---');
        console.log('  error: ' + (r.error || '').replace(/\n/g, ' '));
        if (r.stack) console.log('  stack: |\n    ' + r.stack.replace(/\n/g, '\n    '));
        console.log('  ...');
      }
    });
    console.log('# tests ' + results.length);
    console.log('# pass  ' + passed);
    console.log('# fail  ' + failed);
  } else {
    const bySuite = {};
    results.forEach(r => { (bySuite[r.suite] = bySuite[r.suite] || { p: 0, f: 0, total: 0, items: [] }); bySuite[r.suite].total++; bySuite[r.suite][r.ok ? 'p' : 'f']++; bySuite[r.suite].items.push(r); });
    console.log('');
    console.log('QYRVIA ERP - Test Run');
    console.log('  File: ' + HTML_PATH);
    console.log('  Ran:  ' + report.ranAt);
    console.log('');
    Object.keys(bySuite).sort().forEach(s => {
      const v = bySuite[s];
      const status = v.f ? '\x1b[31mFAIL\x1b[0m' : '\x1b[32mPASS\x1b[0m';
      console.log('  ' + status + '  ' + s.padEnd(22) + v.p + '/' + v.total);
      if (v.f) {
        v.items.filter(r => !r.ok).forEach(r => {
          console.log('         - ' + r.name);
          console.log('           ' + (r.error || ''));
        });
      }
    });
    console.log('');
    console.log('  Total: ' + results.length + '   Passed: ' + passed + '   Failed: ' + failed);
    console.log('');
  }

  process.exit(failed ? 1 : 0);
})();
