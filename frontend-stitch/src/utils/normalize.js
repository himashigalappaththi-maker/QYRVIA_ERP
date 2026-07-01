// Response normalizer. The backend is not uniform: query bus routes (/pms,
// /finance) return { ok, data }, while the revenue/platform/channel controllers
// return { ok, result }. Some payloads are the bare value. unwrap() collapses
// all of these to the payload; asArray()/asObject() coerce to a usable shape so
// views never have to special-case the envelope.

export function unwrap(res) {
  if (res == null) return res;
  if (Array.isArray(res)) return res;
  if (typeof res === 'object') {
    if (Object.prototype.hasOwnProperty.call(res, 'data')) return res.data;
    if (Object.prototype.hasOwnProperty.call(res, 'result')) return res.result;
  }
  return res;
}

export function asArray(res) {
  const u = unwrap(res);
  if (Array.isArray(u)) return u;
  if (u && typeof u === 'object') {
    for (const k of ['items', 'rows', 'list', 'records', 'entries', 'data', 'result',
                     'notifications', 'endpoints', 'connectors', 'users', 'roles']) {
      if (Array.isArray(u[k])) return u[k];
    }
  }
  return [];
}

export function asObject(res) {
  const u = unwrap(res);
  return (u && typeof u === 'object' && !Array.isArray(u)) ? u : {};
}
