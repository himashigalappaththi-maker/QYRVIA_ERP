// Pure formatting helpers (currency, dates, percentages).

export function money(amount, currency = 'LKR') {
  const n = Number(amount) || 0;
  return currency + ' ' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function pct(n) { return (Math.round((Number(n) || 0) * 100) / 100) + '%'; }
export function date(d) { return d ? String(d).slice(0, 10) : '—'; }
export function titleCase(s) { return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
