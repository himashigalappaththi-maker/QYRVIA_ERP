import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, ApiError } from '../src/services/apiClient.js';

function resp(status, body) { return { status, ok: status >= 200 && status < 300, json: async () => body }; }
function mockFetch(queue) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return Array.isArray(queue) ? queue.shift() : queue(url, opts); };
  fn.calls = calls;
  return fn;
}
const sessionStub = (token) => { let cleared = false; return { getToken: () => token, clear() { cleared = true; }, wasCleared: () => cleared }; };

test('attaches JWT + builds query string + returns JSON', async () => {
  const fetchImpl = mockFetch([resp(200, { ok: true, data: [1] })]);
  const api = createApiClient({ baseUrl: '/api', fetchImpl, session: sessionStub('tok123') });
  const out = await api.get('/revenue/kpis', { query: { date_from: '2026-07-01', empty: '' } });
  assert.deepEqual(out, { ok: true, data: [1] });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, '/api/revenue/kpis?date_from=2026-07-01');   // empty param dropped
  assert.equal(call.opts.headers.Authorization, 'Bearer tok123');
});

test('401 clears session, calls onUnauthorized, throws ApiError(401)', async () => {
  const session = sessionStub('tok');
  let unauthorized = false;
  const api = createApiClient({ fetchImpl: mockFetch([resp(401, {})]), session, onUnauthorized: () => { unauthorized = true; } });
  await assert.rejects(() => api.get('/x'), (e) => e instanceof ApiError && e.status === 401);
  assert.equal(session.wasCleared(), true);
  assert.equal(unauthorized, true);
});

test('403 calls onForbidden and throws ApiError(403)', async () => {
  let forbidden = false;
  const api = createApiClient({ fetchImpl: mockFetch([resp(403, {})]), session: sessionStub('t'), onForbidden: () => { forbidden = true; } });
  await assert.rejects(() => api.get('/x'), (e) => e.status === 403);
  assert.equal(forbidden, true);
});

test('non-2xx surfaces the backend error code (legacy string shape)', async () => {
  const api = createApiClient({ fetchImpl: mockFetch([resp(400, { error: 'room_type_id_required' })]), session: sessionStub('t') });
  await assert.rejects(() => api.post('/revenue/rate-plan', {}), (e) => e.status === 400 && e.code === 'room_type_id_required' && e.message === 'room_type_id_required');
});

test('non-2xx surfaces nested error { code, message } (R2 dual shape)', async () => {
  const api = createApiClient({ fetchImpl: mockFetch([resp(400, { ok: false, error: { code: 'room_type_id_required', message: 'room_type_id and date are required' } })]), session: sessionStub('t') });
  await assert.rejects(
    () => api.post('/revenue/rate-plan', {}),
    (e) => e.status === 400 && e.code === 'room_type_id_required' && e.message === 'room_type_id and date are required'
  );
});

test('no token => no Authorization header', async () => {
  const fetchImpl = mockFetch([resp(200, {})]);
  const api = createApiClient({ fetchImpl, session: sessionStub(null) });
  await api.get('/public');
  assert.equal(fetchImpl.calls[0].opts.headers.Authorization, undefined);
});
