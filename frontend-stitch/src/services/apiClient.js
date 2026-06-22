// apiClient - the ONLY way the frontend talks to the backend. Attaches the JWT,
// normalizes errors, and routes 401 (session expiry) / 403 (forbidden) to
// injected handlers. fetch + session are injectable for unit testing in Node.

export class ApiError extends Error {
  constructor(status, code, data) { super(code || ('http_' + status)); this.status = status; this.code = code; this.data = data; }
}

function qs(query) {
  if (!query) return '';
  const parts = Object.entries(query).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v));
  return parts.length ? '?' + parts.join('&') : '';
}

export function createApiClient({ baseUrl = '/api', fetchImpl, session, onUnauthorized, onForbidden } = {}) {
  const _fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  if (!_fetch) throw new Error('apiClient: no fetch available');

  async function request(method, path, { body, query, headers } = {}) {
    const h = Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, headers || {});
    const token = session && session.getToken && session.getToken();
    if (token) h.Authorization = 'Bearer ' + token;

    const res = await _fetch(baseUrl + path + qs(query), {
      method, headers: h, body: body != null ? JSON.stringify(body) : undefined
    });

    if (res.status === 401) {
      if (session && session.clear) session.clear();
      if (onUnauthorized) onUnauthorized();
      throw new ApiError(401, 'session_expired');
    }
    if (res.status === 403) {
      if (onForbidden) onForbidden();
      throw new ApiError(403, 'forbidden');
    }

    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || 'request_failed', data);
    return data;
  }

  return {
    request,
    get: (p, opts) => request('GET', p, opts),
    post: (p, body, opts) => request('POST', p, Object.assign({ body }, opts)),
    put: (p, body, opts) => request('PUT', p, Object.assign({ body }, opts)),
    del: (p, opts) => request('DELETE', p, opts)
  };
}
