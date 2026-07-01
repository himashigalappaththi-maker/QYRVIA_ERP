// Pure formatting helpers (currency, dates, percentages, numbers).

export function money(amount, currency = 'LKR') {
  const n = Number(amount) || 0;
  return currency + ' ' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function num(n) { return (Number(n) || 0).toLocaleString(); }
export function pct(n) { return (Math.round((Number(n) || 0) * 100) / 100) + '%'; }
export function date(d) { return d ? String(d).slice(0, 10) : '—'; }
export function datetime(d) {
  if (!d) return '—';
  const s = String(d);
  return s.length > 16 ? s.slice(0, 10) + ' ' + s.slice(11, 16) : s;
}
export function dash(v) { return (v == null || v === '') ? '—' : v; }
export function titleCase(s) { return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }

/** Local YYYY-MM-DD for "today" + offset days (deterministic display helper). */
export function isoDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}
