'use strict';

/**
 * Phase 59 — Attendance / Incident / Maintenance frontend bridge tests.
 * 24-case deterministic verification of structural invariants and behavior.
 */

const { test }         = require('node:test');
const assert           = require('node:assert/strict');
const fs               = require('node:fs');
const path             = require('node:path');
const vm               = require('node:vm');
const { execFileSync } = require('node:child_process');

// ── Paths ─────────────────────────────────────────────────────────────────────

const REPO_ROOT       = path.resolve(__dirname, '..', '..');
const HTML_PATH       = path.join(REPO_ROOT, 'QYRVIA_ERP_V35-1.html');
// Wrong path: parent dir, missing "Qyrvia ERP" segment.
const HTML_PATH_WRONG = path.resolve(REPO_ROOT, '..', 'QYRVIA_ERP_V35-1.html');

// ── HTML source (read once) ───────────────────────────────────────────────────

const HTML       = fs.readFileSync(HTML_PATH, 'utf8');
const HTML_LINES = HTML.split('\n');

const P59_START = HTML.indexOf('// ─── Phase 59');
const P59_END   = HTML.lastIndexOf('})(window);') + '})(window);'.length;
const P59_BLOCK = HTML.slice(P59_START, P59_END);

// ── Git helper ────────────────────────────────────────────────────────────────

function gitLines(args) {
  const output = execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

// ── Sandbox factory ───────────────────────────────────────────────────────────

function buildSandbox({ hasPerm = () => false, AUTH = null, fetchImpl } = {}) {
  const elements = {};
  const OPS      = { incidents: null, jobs: null };
  const toasts   = [];
  const storage  = {};
  const renders  = { incidentsCalls: 0, maintOpsCalls: 0 };

  const doc = {
    getElementById(id) {
      if (!elements[id]) elements[id] = { innerHTML: '' };
      return elements[id];
    },
    querySelector() { return null; }
  };

  const w = {
    AUTH, hasPerm,
    toast(msg, level) { toasts.push({ msg, level }); },
    showPage: undefined,
    att59LoadStatus: undefined, att59PostEvent: undefined, att59Retry: undefined,
    incBridgeRetry:  undefined, maintBridgeRetry: undefined,
    incSubmit:       undefined, incClose: undefined,
    maintSubmitNew:  undefined, maintComplete: undefined,
  };

  const ctx = vm.createContext({
    window: w, document: doc,
    localStorage: {
      getItem:    k => (storage[k] !== undefined ? storage[k] : null),
      setItem:    (k, v) => { storage[k] = v; },
      removeItem: k => { delete storage[k]; },
    },
    fetch: fetchImpl
      ? (url, opts) => fetchImpl(url, opts)
      : () => Promise.reject(new Error('fetch not configured')),
    OPS,
    Array, Date, Error, JSON, Promise, Object, console,
    renderIncidents: function() { renders.incidentsCalls++; },
    renderMaintOps:  function() { renders.maintOpsCalls++; },
  });

  const script = new vm.Script('(function(w){ ' + P59_BLOCK + ' })(window);');
  script.runInContext(ctx);

  return { w, elements, toasts, OPS, renders };
}

// Drain all pending Promise microtasks.
function drain() { return new Promise(r => setTimeout(r, 50)); }

// ── 1. Correct repository HTML path ──────────────────────────────────────────

test('p59-fe-01: HTML loaded from correct repository path, not wrong parent-dir path', () => {
  const resolved      = path.resolve(HTML_PATH);
  const expected      = path.join(REPO_ROOT, 'QYRVIA_ERP_V35-1.html');
  const wrongResolved = path.resolve(HTML_PATH_WRONG);

  assert.equal(resolved, expected,
    'HTML_PATH must resolve inside "Qyrvia ERP" subdirectory');
  assert.notEqual(resolved, wrongResolved,
    'HTML_PATH must not resolve to the parent-directory wrong path');
  assert.ok(fs.existsSync(HTML_PATH),
    'Repository HTML must exist at the expected path');
});

// ── 2. No second HTML file at repo root ──────────────────────────────────────

test('p59-fe-02: no second HTML file at repository root', () => {
  const htmlFiles = fs.readdirSync(REPO_ROOT).filter(f => f.endsWith('.html'));
  assert.equal(htmlFiles.length, 1,
    'Expected exactly one .html at repo root, found: ' + htmlFiles.join(', '));
  assert.equal(htmlFiles[0], 'QYRVIA_ERP_V35-1.html',
    'The single HTML file must be QYRVIA_ERP_V35-1.html');
});

// ── 3. att59OperationalSection — exactly one HTML element declaration ─────────

test('p59-fe-03: att59OperationalSection has exactly one HTML element declaration', () => {
  const divCount = (HTML.match(/id="att59OperationalSection"/g) || []).length;
  assert.equal(divCount, 1,
    'Must have exactly one id="att59OperationalSection" div');
  assert.ok(HTML.includes("document.getElementById('att59OperationalSection')"),
    'Phase 59 JS must reference att59OperationalSection via getElementById');
});

// ── 4. Operational section outside attGrid ────────────────────────────────────

test('p59-fe-04: att59OperationalSection is outside attGrid', () => {
  const attGridLine = HTML_LINES.findIndex(l => l.includes('id="attGrid"'));
  assert.ok(attGridLine >= 0, 'attGrid must exist in HTML');

  let depth = 0, started = false, attGridEnd = -1;
  for (let i = attGridLine; i < HTML_LINES.length; i++) {
    const opens  = (HTML_LINES[i].match(/<div/g)  || []).length;
    const closes = (HTML_LINES[i].match(/<\/div/g) || []).length;
    if (!started && opens > 0) started = true;
    if (started) {
      depth += opens - closes;
      if (depth <= 0) { attGridEnd = i; break; }
    }
  }
  assert.ok(attGridEnd > 0, 'attGrid closing tag must be found');

  const secLine = HTML_LINES.findIndex(l => l.includes('id="att59OperationalSection"'));
  assert.ok(secLine > attGridEnd,
    'att59OperationalSection (line ' + (secLine + 1) +
    ') must be AFTER attGrid end (line ' + (attGridEnd + 1) + ')');
});

// ── 5. renderAttendance contains no Phase 59 boot or helper call ─────────────

test('p59-fe-05: renderAttendance() contains no Phase 59 boot or helper call', () => {
  const raStart = HTML_LINES.findIndex(l => l.includes('function renderAttendance'));
  assert.ok(raStart >= 0, 'renderAttendance must be defined in HTML');

  let depth = 0, started = false, raEnd = raStart;
  for (let i = raStart; i < HTML_LINES.length && i < raStart + 600; i++) {
    if (!started && HTML_LINES[i].includes('{')) started = true;
    if (started) {
      depth += (HTML_LINES[i].match(/\{/g) || []).length;
      depth -= (HTML_LINES[i].match(/\}/g) || []).length;
      if (depth <= 0) { raEnd = i; break; }
    }
  }
  const raBlock = HTML_LINES.slice(raStart, raEnd + 1).join('\n');
  const forbidden = [
    'att59Boot', 'att59LoadStatus', '_att59Sec', '_att59Card',
    '_p59Fetch', 'incBridgeLoad', 'maintBridgeLoad',
  ];
  for (const sym of forbidden) {
    assert.ok(!raBlock.includes(sym),
      'renderAttendance must not reference Phase 59 symbol: ' + sym);
  }
});

// ── 6. Attendance status endpoint is /api/attendance/status/my ───────────────

test('p59-fe-06: Phase 59 uses /attendance/status/my for authoritative status', () => {
  assert.ok(P59_BLOCK.includes('/attendance/status/my'),
    'Phase 59 block must reference /attendance/status/my');
});

// ── 7. /attendance/events/my is history-only ──────────────────────────────────

test('p59-fe-07: /attendance/events/my appears after status/my and not inside att59PostEvent', () => {
  const statusIdx = P59_BLOCK.indexOf('/attendance/status/my');
  const eventsIdx = P59_BLOCK.indexOf('/attendance/events/my');
  assert.ok(eventsIdx > statusIdx,
    '/attendance/events/my must appear after /attendance/status/my in source order');

  const postFnStart = P59_BLOCK.indexOf('function att59PostEvent');
  const postFnEnd   = P59_BLOCK.indexOf('w.att59LoadStatus = att59LoadStatus');
  const postFnBlock = P59_BLOCK.slice(postFnStart, postFnEnd);
  assert.ok(!postFnBlock.includes('/attendance/events/my'),
    'att59PostEvent must not directly reference /attendance/events/my');
});

// ── 8. Network failure → unverified state, not a valid status ─────────────────

test('p59-fe-08: network failure routes to unverified state, not Checked In/Out/no_events', async () => {
  const { w, elements } = buildSandbox({
    fetchImpl: () => Promise.reject(new Error('net')),
  });
  await w.att59LoadStatus().catch(() => {});
  const html = (elements['att59OperationalSection'] || { innerHTML: '' }).innerHTML;
  assert.ok(html.length > 0,      'att59OperationalSection must have content after network failure');
  assert.ok(!html.includes('Checked In'),     'Network failure must not show Checked In');
  assert.ok(!html.includes('Checked Out'),    'Network failure must not show Checked Out');
  assert.ok(!html.includes('No events today'),'Network failure must not show no_events state');
});

// ── 9. Network failure cannot render no_events or checked_out ────────────────

test('p59-fe-09: network failure never renders no_events or checked_out state', async () => {
  const { w, elements } = buildSandbox({
    fetchImpl: () => Promise.reject(new Error('net')),
  });
  await w.att59LoadStatus().catch(() => {});
  const html = (elements['att59OperationalSection'] || { innerHTML: '' }).innerHTML;
  assert.ok(!html.includes('No events today'), 'Must not show no_events after network failure');
  assert.ok(!html.includes('Checked Out'),     'Must not show checked_out after network failure');
  assert.ok(html.includes('att59Retry'),       'Must include Retry after network failure');
});

// ── 10. Unverified state has Retry and no action buttons ─────────────────────

test('p59-fe-10: unverified state has Retry and no check-in/out action buttons', async () => {
  const { w, elements } = buildSandbox({
    fetchImpl: () => Promise.reject(new Error('net')),
    hasPerm: () => true,  // even with all permissions
  });
  await w.att59LoadStatus().catch(() => {});
  const html = (elements['att59OperationalSection'] || { innerHTML: '' }).innerHTML;
  assert.ok(html.includes('att59Retry'),     'Unverified must have Retry button');
  assert.ok(!html.includes("'check_in'"),    'Unverified must not have check_in onclick');
  assert.ok(!html.includes("'check_out'"),   'Unverified must not have check_out onclick');
});

// ── 11. 401 → session-expired denial, no successful state ────────────────────

test('p59-fe-11: 401 shows session-expired denial, no Checked In state or action buttons', async () => {
  const { w, elements } = buildSandbox({
    fetchImpl: () => Promise.resolve({
      ok: false, status: 401,
      json: () => Promise.resolve({ ok: false, error: 'unauthorized' }),
    }),
  });
  await w.att59LoadStatus().catch(() => {});
  const html = (elements['att59OperationalSection'] || { innerHTML: '' }).innerHTML;
  assert.ok(html.includes('log in'),          '401 must show session-expired / log-in message');
  assert.ok(!html.includes('Checked In'),     '401 must not show Checked In');
  assert.ok(!html.includes('att59PostEvent'), '401 must not show action buttons');
});

// ── 12. 403 → permission-denied denial, no action buttons ────────────────────

test('p59-fe-12: 403 shows permission-denied denial, no action buttons', async () => {
  const { w, elements } = buildSandbox({
    fetchImpl: () => Promise.resolve({
      ok: false, status: 403,
      json: () => Promise.resolve({ ok: false, error: 'forbidden' }),
    }),
  });
  await w.att59LoadStatus().catch(() => {});
  const html = (elements['att59OperationalSection'] || { innerHTML: '' }).innerHTML;
  assert.ok(!html.includes('att59PostEvent'), '403 must not show action buttons');
  assert.ok(
    html.includes('permission') || html.includes('Permission') ||
    html.includes('denied')     || html.includes('Denied'),
    '403 must show permission-denied message'
  );
});

// ── 13. Property-context failures render controlled states ────────────────────

test('p59-fe-13a: attendance_property_required (400) shows property message, no action buttons', async () => {
  const { w, elements } = buildSandbox({
    fetchImpl: () => Promise.resolve({
      ok: false, status: 400,
      json: () => Promise.resolve({ ok: false, error: 'attendance_property_required' }),
    }),
  });
  await w.att59LoadStatus().catch(() => {});
  const html = (elements['att59OperationalSection'] || { innerHTML: '' }).innerHTML;
  assert.ok(!html.includes('att59PostEvent'),
    'property_required must not show action buttons');
  assert.ok(html.includes('property') || html.includes('Property'),
    'property_required must show property message');
});

test('p59-fe-13b: property_access_denied (403) shows denial, no action buttons', async () => {
  const { w, elements } = buildSandbox({
    fetchImpl: () => Promise.resolve({
      ok: false, status: 403,
      json: () => Promise.resolve({ ok: false, error: 'property_access_denied' }),
    }),
  });
  await w.att59LoadStatus().catch(() => {});
  const html = (elements['att59OperationalSection'] || { innerHTML: '' }).innerHTML;
  assert.ok(!html.includes('att59PostEvent'),
    'property_access_denied must not show action buttons');
  assert.ok(
    html.includes('denied')  || html.includes('Denied') ||
    html.includes('access')  || html.includes('Access'),
    'property_access_denied must show denial message'
  );
});

// ── 14. Duplicate submission blocked while first is pending ───────────────────

test('p59-fe-14: second att59PostEvent is blocked while first is pending', () => {
  let fetchCount = 0;
  const { w } = buildSandbox({
    fetchImpl: () => { fetchCount++; return new Promise(() => {}); }, // never resolves
  });
  w.att59PostEvent('check_in');  // sets busy, issues POST (fetchCount = 1)
  fetchCount = 0;                // reset
  w.att59PostEvent('check_in');  // must be blocked — no new fetch
  assert.equal(fetchCount, 0,
    'Second att59PostEvent while first pending must issue 0 fetch calls');
});

// ── 15. _att59ActionBusy resets on all three completion paths ─────────────────

test('p59-fe-15a: _att59ActionBusy resets after successful POST and status reload', async () => {
  let fetchCount = 0;
  const { w } = buildSandbox({
    fetchImpl: (url, opts) => {
      fetchCount++;
      const method = (opts && opts.method) || 'GET';
      const u = String(url);
      if (method === 'POST') {
        return Promise.resolve({ ok: true, status: 201,
          json: () => Promise.resolve({ ok: true, data: { id: '1' } }) });
      }
      if (u.includes('/attendance/status/my')) {
        return Promise.resolve({ ok: true, status: 200,
          json: () => Promise.resolve({ ok: true, data: {
            status: 'checked_in',
            open_check_in: { event_at: new Date().toISOString(), source: 'test' },
            latest_event: null,
          }}) });
      }
      return Promise.resolve({ ok: true, status: 200,
        json: () => Promise.resolve({ ok: true, data: [] }) });
    },
  });

  w.att59PostEvent('check_in');
  await drain();

  fetchCount = 0;
  w.att59PostEvent('check_out');
  await drain();
  assert.ok(fetchCount > 0,
    '_att59ActionBusy must reset after success; second call issued ' + fetchCount + ' fetches');
});

test('p59-fe-15b: _att59ActionBusy resets after HTTP rejection (409)', async () => {
  let fetchCount = 0;
  const { w } = buildSandbox({
    fetchImpl: (url, opts) => {
      fetchCount++;
      const method = (opts && opts.method) || 'GET';
      if (method === 'POST') {
        return Promise.resolve({ ok: false, status: 409,
          json: () => Promise.resolve({ ok: false, error: 'open_checkin_exists' }) });
      }
      return Promise.resolve({ ok: false, status: 503,
        json: () => Promise.resolve({ ok: false, error: 'server_error' }) });
    },
  });

  w.att59PostEvent('check_in');
  await drain();

  fetchCount = 0;
  w.att59PostEvent('check_in');
  await drain();
  assert.ok(fetchCount > 0,
    '_att59ActionBusy must reset after HTTP rejection; second call issued ' + fetchCount + ' fetches');
});

test('p59-fe-15c: _att59ActionBusy resets after network rejection (unavailable)', async () => {
  let fetchCount = 0;
  const { w } = buildSandbox({
    fetchImpl: () => { fetchCount++; return Promise.reject(new Error('net')); },
  });

  w.att59PostEvent('check_in');
  await drain();

  fetchCount = 0;
  w.att59PostEvent('check_in');
  await drain();
  assert.ok(fetchCount > 0,
    '_att59ActionBusy must reset after network failure; second call issued ' + fetchCount + ' fetches');
});

// ── 16. HTTP-rejected action does not show Checked In ────────────────────────

test('p59-fe-16: HTTP-rejected att59PostEvent does not render Checked In state', async () => {
  const { w, elements } = buildSandbox({
    fetchImpl: (url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (method === 'POST') {
        return Promise.resolve({ ok: false, status: 409,
          json: () => Promise.resolve({ ok: false, error: 'open_checkin_exists' }) });
      }
      return Promise.resolve({ ok: false, status: 503,
        json: () => Promise.resolve({ ok: false, error: 'server_error' }) });
    },
  });
  w.att59PostEvent('check_in');
  await drain();
  const html = (elements['att59OperationalSection'] || { innerHTML: '' }).innerHTML;
  assert.ok(!html.includes('Checked In'),
    'Rejected action must not render Checked In state');
});

// ── 17. Successful action reloads authoritative status ────────────────────────

test('p59-fe-17: successful att59PostEvent reloads GET /attendance/status/my', async () => {
  const calledUrls = [];
  const { w } = buildSandbox({
    fetchImpl: (url, opts) => {
      calledUrls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
      const method = (opts && opts.method) || 'GET';
      const u = String(url);
      if (method === 'POST') {
        return Promise.resolve({ ok: true, status: 201,
          json: () => Promise.resolve({ ok: true, data: { id: '1' } }) });
      }
      if (u.includes('/attendance/status/my')) {
        return Promise.resolve({ ok: true, status: 200,
          json: () => Promise.resolve({ ok: true, data: {
            status: 'checked_in',
            open_check_in: { event_at: new Date().toISOString(), source: 'test' },
            latest_event: null,
          }}) });
      }
      return Promise.resolve({ ok: true, status: 200,
        json: () => Promise.resolve({ ok: true, data: [] }) });
    },
  });
  w.att59PostEvent('check_in');
  await drain();
  const statusReloads = calledUrls.filter(
    c => c.url.includes('/attendance/status/my') && c.method === 'GET'
  );
  assert.ok(statusReloads.length >= 1,
    'Successful att59PostEvent must reload from GET /attendance/status/my; calls: ' +
    JSON.stringify(calledUrls));
});

// ── 18. Incident load failure → unavailable state with Retry ──────────────────

test('p59-fe-18: incident network failure renders incBridgeRenderUnavailable with Retry', async () => {
  const { w, elements } = buildSandbox({
    fetchImpl: () => Promise.reject(new Error('net')),
  });
  w.incBridgeRetry();  // does not return a Promise — drain to let chain settle
  await drain();
  const html = (elements['incidentsList'] || { innerHTML: '' }).innerHTML;
  assert.ok(html.includes('incBridgeRetry'),
    'Incident unavailable state must have Retry button referencing incBridgeRetry');
  assert.ok(html.includes('could not be loaded') || html.includes('unavailable'),
    'Incident unavailable state must describe the failure');
});

// ── 19. Maintenance load failure → unavailable state with Retry ───────────────

test('p59-fe-19: maintenance network failure renders maintBridgeRenderUnavailable with Retry', async () => {
  const { w, elements } = buildSandbox({
    fetchImpl: () => Promise.reject(new Error('net')),
  });
  w.maintBridgeRetry();  // does not return a Promise — drain to let chain settle
  await drain();
  const html = (elements['maintJobsList'] || { innerHTML: '' }).innerHTML;
  assert.ok(html.includes('maintBridgeRetry'),
    'Maintenance unavailable state must have Retry button referencing maintBridgeRetry');
  assert.ok(html.includes('could not be loaded') || html.includes('unavailable'),
    'Maintenance unavailable state must describe the failure');
});

// ── 20. Load failures do not present a false success or stale state ───────────

test('p59-fe-20a: incident load failure renders unavailable, not success or empty-list state', async () => {
  const { w, elements } = buildSandbox({
    fetchImpl: () => Promise.reject(new Error('net')),
  });
  w.incBridgeRetry();
  await drain();
  const html = (elements['incidentsList'] || { innerHTML: '' }).innerHTML;
  assert.ok(html.includes('could not be loaded') || html.includes('unavailable'),
    'incidentsList must show unavailable state after load failure');
  assert.ok(!html.includes('<table') && !html.includes('No incidents'),
    'incidentsList must not show a success/empty-list template after load failure');
});

test('p59-fe-20b: maintenance load failure renders unavailable, not success or empty-list state', async () => {
  const { w, elements } = buildSandbox({
    fetchImpl: () => Promise.reject(new Error('net')),
  });
  w.maintBridgeRetry();
  await drain();
  const html = (elements['maintJobsList'] || { innerHTML: '' }).innerHTML;
  assert.ok(html.includes('could not be loaded') || html.includes('unavailable'),
    'maintJobsList must show unavailable state after load failure');
  assert.ok(!html.includes('<table') && !html.includes('No jobs'),
    'maintJobsList must not show a success/empty-list template after load failure');
});

// ── 21. Permission visibility uses hasPerm ────────────────────────────────────

test('p59-fe-21: Check In button gated by hasPerm(attendance, record)', async () => {
  const statusFetch = () => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ ok: true, data: {
      status: 'no_events', open_check_in: null, latest_event: null,
    }}),
  });

  const { w: wNo, elements: elNo } = buildSandbox({ fetchImpl: statusFetch, hasPerm: () => false });
  await wNo.att59LoadStatus().catch(() => {});
  const htmlNo = (elNo['att59OperationalSection'] || { innerHTML: '' }).innerHTML;
  assert.ok(!htmlNo.includes('att59PostEvent'),
    'Without record perm: att59PostEvent must not appear');

  const { w: wYes, elements: elYes } = buildSandbox({
    fetchImpl: statusFetch,
    hasPerm: (mod, act) => mod === 'attendance' && act === 'record',
  });
  await wYes.att59LoadStatus().catch(() => {});
  const htmlYes = (elYes['att59OperationalSection'] || { innerHTML: '' }).innerHTML;
  assert.ok(htmlYes.includes('att59PostEvent'),
    'With record perm: att59PostEvent must appear');
});

// ── 22. Existing frontend bridges remain intact — exact markers ───────────────

test('p59-fe-22a: Gate Pass bridge — exact API path and function markers intact', () => {
  assert.ok(HTML.includes("'/api/gatepass'"),
    "Gate Pass API path string '/api/gatepass' must be present");
  assert.ok(HTML.includes('function gp47Fetch'),
    'Gate Pass bridge function gp47Fetch must be present');
  assert.ok(HTML.includes('showPage47'),
    'Gate Pass showPage47 wrapper must be present');
});

test('p59-fe-22b: POS/KOT bridge — exact API path and function markers intact', () => {
  assert.ok(HTML.includes("'/api/pos'"),
    "POS API path string '/api/pos' must be present");
  assert.ok(HTML.includes('function kot47Fetch'),
    'POS bridge function kot47Fetch must be present');
  assert.ok(HTML.includes('id="page-kot"'),
    'KOT page element id="page-kot" must be present');
});

test('p59-fe-22c: Patrol bridge — exact API paths and function markers intact', () => {
  assert.ok(HTML.includes("'/api/patrol/logs'"),
    "Patrol API path '/api/patrol/logs' must be present");
  assert.ok(HTML.includes('function patrol48Load'),
    'Patrol bridge function patrol48Load must be present');
  assert.ok(HTML.includes('function patrolCheckIn48'),
    'Patrol function patrolCheckIn48 must be present');
  assert.ok(HTML.includes('showPage48'),
    'Patrol showPage48 wrapper must be present');
});

// ── 23. No mobile file changed ────────────────────────────────────────────────

test('p59-fe-23: no tracked or untracked ERP_Mobile_app file changed', () => {
  const tracked   = gitLines(['diff', '--name-only', 'HEAD', '--', 'ERP_Mobile_app']);
  const untracked = gitLines(['ls-files', '--others', '--exclude-standard', '--', 'ERP_Mobile_app']);
  assert.deepEqual(tracked,   [],
    'Tracked mobile files changed: '   + JSON.stringify(tracked));
  assert.deepEqual(untracked, [],
    'Untracked mobile files created: ' + JSON.stringify(untracked));
});

// ── 24. No forbidden catch patterns in Phase 59 IIFE ─────────────────────────

test('p59-fe-24a: no catch (_) {} in Phase 59 IIFE', () => {
  const hits = (P59_BLOCK.match(/catch\s*\(_\)\s*\{/g) || []);
  assert.equal(hits.length, 0,
    'Phase 59 must not contain catch (_) {}; found: ' + JSON.stringify(hits));
});

test('p59-fe-24b: no empty or comment-only catch body in Phase 59 IIFE', () => {
  const hits = (P59_BLOCK.match(/catch\s*\([^)]*\)\s*\{\s*(\/\*[^*]*\*\/)?\s*\}/g) || []);
  assert.equal(hits.length, 0,
    'Phase 59 must not have empty or comment-only catch blocks; found: ' + JSON.stringify(hits));
});

// ── 25. Incident bridge — success, empty, and malformed-response states ───────

test('p59-fe-25a: incBridgeLoad success — OPS.incidents mapped and renderIncidents called', async () => {
  const { w, OPS, renders } = buildSandbox({
    fetchImpl: () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ ok: true, data: [
        { id: 'INC001', title: 'Broken window', severity: 'high', category: 'Safety',
          status: 'open', occurred_at: '2026-07-15T08:00:00Z', location_text: 'Lobby',
          description: 'Window cracked', reported_by_user_id: 'u1' }
      ]}),
    }),
  });
  w.incBridgeRetry();
  await drain();
  assert.ok(Array.isArray(OPS.incidents), 'OPS.incidents must be an array after success');
  assert.equal(OPS.incidents.length, 1, 'OPS.incidents must have 1 item from the response');
  assert.equal(OPS.incidents[0].id, 'INC001', 'Mapped incident must preserve id from server row');
  assert.ok(renders.incidentsCalls >= 1, 'renderIncidents must have been called on success');
});

test('p59-fe-25b: incBridgeLoad empty list — OPS.incidents is [] and renderIncidents called', async () => {
  const { w, OPS, renders } = buildSandbox({
    fetchImpl: () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ ok: true, data: [] }),
    }),
  });
  w.incBridgeRetry();
  await drain();
  assert.ok(Array.isArray(OPS.incidents), 'OPS.incidents must be an array for empty server response');
  assert.equal(OPS.incidents.length, 0, 'OPS.incidents must be empty when server returns []');
  assert.ok(renders.incidentsCalls >= 1, 'renderIncidents must still be called for empty list');
});

test('p59-fe-25c: incBridgeLoad malformed response — OPS.incidents falls back to []', async () => {
  const { w, OPS, renders } = buildSandbox({
    fetchImpl: () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ ok: true, data: null }),
    }),
  });
  w.incBridgeRetry();
  await drain();
  assert.ok(Array.isArray(OPS.incidents), 'OPS.incidents must be an array even for null data field');
  assert.equal(OPS.incidents.length, 0, 'Malformed (null data) must fall back to empty array');
});

// ── 26. Maintenance bridge — success, empty, and malformed-response states ────

test('p59-fe-26a: maintBridgeLoad success — OPS.jobs mapped and renderMaintOps called', async () => {
  const { w, OPS, renders } = buildSandbox({
    fetchImpl: () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ ok: true, data: [
        { id: 'MJ001', title: 'Fix AC', priority: 'high', status: 'open',
          asset_or_location: 'Room 101', description: 'AC unit broken',
          assigned_to_user_id: null, created_at: '2026-07-15T08:00:00Z' }
      ]}),
    }),
  });
  w.maintBridgeRetry();
  await drain();
  assert.ok(Array.isArray(OPS.jobs), 'OPS.jobs must be an array after success');
  assert.equal(OPS.jobs.length, 1, 'OPS.jobs must have 1 item from the response');
  assert.equal(OPS.jobs[0].id, 'MJ001', 'Mapped job must preserve id from server row');
  assert.ok(renders.maintOpsCalls >= 1, 'renderMaintOps must have been called on success');
});

test('p59-fe-26b: maintBridgeLoad empty list — OPS.jobs is [] and renderMaintOps called', async () => {
  const { w, OPS, renders } = buildSandbox({
    fetchImpl: () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ ok: true, data: [] }),
    }),
  });
  w.maintBridgeRetry();
  await drain();
  assert.ok(Array.isArray(OPS.jobs), 'OPS.jobs must be an array for empty server response');
  assert.equal(OPS.jobs.length, 0, 'OPS.jobs must be empty when server returns []');
  assert.ok(renders.maintOpsCalls >= 1, 'renderMaintOps must still be called for empty list');
});

test('p59-fe-26c: maintBridgeLoad malformed response — OPS.jobs falls back to []', async () => {
  const { w, OPS, renders } = buildSandbox({
    fetchImpl: () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ ok: true, data: null }),
    }),
  });
  w.maintBridgeRetry();
  await drain();
  assert.ok(Array.isArray(OPS.jobs), 'OPS.jobs must be an array even for null data field');
  assert.equal(OPS.jobs.length, 0, 'Malformed (null data) must fall back to empty array');
});

// ── 27. /attendance/events/my bounded limit ───────────────────────────────────

test('p59-fe-27: /attendance/events/my uses bounded ?limit=50 — no unlimited history fetch', () => {
  assert.ok(P59_BLOCK.includes('/attendance/events/my?limit=50'),
    'Phase 59 must fetch attendance events with explicit ?limit=50 to prevent unbounded history load');
});
