'use strict';

/**
 * Minimal 5-field cron parser + nextRun calculator.
 *
 * Format:  minute hour day-of-month month day-of-week
 *
 * Supported:
 *   *          any
 *   N          single value
 *   N,M,K      list
 *   N-M        range
 *   *\/N       step (every N starting at field min)
 *   N-M/S      range with step
 *
 * Day-of-week: 0-6 (Sun=0). Aliases sun/mon/.. not supported (use 0-6).
 * Month:       1-12 numeric only.
 * Day-of-month and day-of-week act per standard cron: if both are restricted,
 * a date matches if either matches.
 *
 * Timezone: pure-JS UTC implementation. The optional `timezone` argument is
 * accepted as a label string; the calculation always operates on a UTC clock
 * (sufficient for QYRVIA Phase 4 where servers run in UTC and a property's
 * business date is tracked separately at the row level).
 */

const FIELDS = [
  { min: 0,  max: 59 },   // minute
  { min: 0,  max: 23 },   // hour
  { min: 1,  max: 31 },   // dayOfMonth
  { min: 1,  max: 12 },   // month
  { min: 0,  max: 6  }    // dayOfWeek
];

function _parseField(expr, idx) {
  const { min, max } = FIELDS[idx];
  if (expr === '*') {
    const out = [];
    for (let v = min; v <= max; v++) out.push(v);
    return out;
  }
  const result = new Set();
  expr.split(',').forEach((part) => {
    let step = 1;
    let body = part;
    if (part.includes('/')) {
      const [b, s] = part.split('/');
      body = b;
      step = parseInt(s, 10);
      if (!Number.isInteger(step) || step <= 0) throw new Error('cron: invalid step in "' + part + '"');
    }
    let lo, hi;
    if (body === '*') { lo = min; hi = max; }
    else if (body.includes('-')) {
      const [a, b] = body.split('-').map((x) => parseInt(x, 10));
      lo = a; hi = b;
    } else {
      lo = parseInt(body, 10); hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error('cron: invalid expr "' + part + '"');
    if (lo < min || hi > max || lo > hi) throw new Error('cron: out of range "' + part + '" (' + min + '..' + max + ')');
    for (let v = lo; v <= hi; v += step) result.add(v);
  });
  return Array.from(result).sort((a, b) => a - b);
}

function parseCron(expr) {
  if (typeof expr !== 'string') throw new Error('cron: expression must be a string');
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron: expected 5 fields, got ' + parts.length);
  const [m, h, dom, mon, dow] = parts;
  return {
    minute:      _parseField(m,   0),
    hour:        _parseField(h,   1),
    dayOfMonth:  _parseField(dom, 2),
    month:       _parseField(mon, 3),
    dayOfWeek:   _parseField(dow, 4),
    raw:         expr,
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*'
  };
}

function _setOf(arr) { const s = new Set(arr); return s; }

function nextRun(cronExpr, fromIso) {
  const cron = (typeof cronExpr === 'string') ? parseCron(cronExpr) : cronExpr;
  const startMs = fromIso ? Date.parse(fromIso) : Date.now();
  if (!Number.isFinite(startMs)) throw new Error('nextRun: invalid fromIso');

  // Start from the next minute boundary
  let t = new Date(Math.floor(startMs / 60000) * 60000 + 60000);

  const sMin  = _setOf(cron.minute);
  const sHr   = _setOf(cron.hour);
  const sDom  = _setOf(cron.dayOfMonth);
  const sMon  = _setOf(cron.month);
  const sDow  = _setOf(cron.dayOfWeek);

  // Bound the search to 4 years to avoid pathological infinite loops
  const HARD_LIMIT = Date.now() + 4 * 365 * 86400 * 1000 + startMs - Date.now();
  while (t.getTime() < HARD_LIMIT) {
    const mo = t.getUTCMonth() + 1;
    if (!sMon.has(mo)) { t = _nextMonth(t); continue; }
    const dom = t.getUTCDate();
    const dow = t.getUTCDay();
    const domMatch = sDom.has(dom);
    const dowMatch = sDow.has(dow);
    let dayMatch;
    if (cron.domRestricted && cron.dowRestricted) dayMatch = domMatch || dowMatch;
    else if (cron.domRestricted)                  dayMatch = domMatch;
    else if (cron.dowRestricted)                  dayMatch = dowMatch;
    else                                          dayMatch = true;
    if (!dayMatch) { t = _nextDay(t); continue; }
    const hr = t.getUTCHours();
    if (!sHr.has(hr)) { t = _nextHour(t); continue; }
    const mi = t.getUTCMinutes();
    if (!sMin.has(mi)) { t = new Date(t.getTime() + 60000); continue; }
    return t.toISOString();
  }
  throw new Error('nextRun: could not find a match within 4 years');
}

function _nextMonth(d) {
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0));
  return n;
}
function _nextDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0));
}
function _nextHour(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1, 0, 0));
}

module.exports = { parseCron, nextRun };
