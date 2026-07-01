'use strict';

/** Phase 27.1 - real LLM AIProvider: SecretProvider key, extraction, low-confidence fallback, swap. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildLlmAiProvider, sanitizeEntities } = require('../src/ai-agent/provider/llmAiProvider');
const { buildHttpLlmTransport } = require('../src/ai-agent/provider/llmTransport');
const { buildAiProvider } = require('../src/ai-agent/provider');
const { buildAiAgentService } = require('../src/ai-agent/aiAgentService');

const CTX = { tenantId: 't1', requestId: 'rq' };
const fakeSecret = { async get(ref, { tenant_id }) { return { api_key: 'sk-' + ref + '-' + tenant_id }; } };

// Scripted transport: returns canned content per call; records messages + apiKey.
function scriptedTransport(script) {
  const calls = [];
  let i = 0;
  return { calls, async chat(messages, { apiKey } = {}) { calls.push({ messages, apiKey }); const r = typeof script === 'function' ? script(messages, i) : script[i]; i += 1; return r || { ok: true, content: '{}' }; } };
}

// 1. SecretProvider resolution
test('LLM provider resolves the API key via the SecretProvider (never in the prompt)', async () => {
  const tx = scriptedTransport([{ ok: true, content: '{"intent":"new_booking","confidence":0.9}' }]);
  const p = buildLlmAiProvider({ transport: tx, secretProvider: fakeSecret, credentialsRef: 'openai:p1', tenantId: 't1' });
  await p.classifyIntent('book a room');
  assert.equal(tx.calls[0].apiKey, 'sk-openai:p1-t1');
  assert.ok(!JSON.stringify(tx.calls[0].messages).includes('sk-'), 'key must not be in the prompt body');
});

// 2. Single-shot extraction
test('single-shot extraction: LLM returns all slots at once, sanitized', async () => {
  const tx = scriptedTransport([{ ok: true, content: 'sure: {"guest_name":"Jane Doe","room_type":"suite","arrival":"2026-07-01","departure":"2026-07-03","adults":"2","junk":"x"}' }]);
  const p = buildLlmAiProvider({ transport: tx, secretProvider: fakeSecret, credentialsRef: 'r', tenantId: 't1' });
  const e = await p.extractEntities('one message with everything');
  assert.deepEqual(e, { guest_name: 'Jane Doe', room_type: 'suite', arrival: '2026-07-01', departure: '2026-07-03', adults: 2 });
  assert.equal(e.junk, undefined); // unknown keys dropped
});

// 3. Multi-turn extraction (via the agent, provider swapped to LLM)
test('multi-turn extraction through the agent using the LLM provider', async () => {
  const tx = scriptedTransport((messages) => {
    const user = messages[messages.length - 1].content.toLowerCase();
    const isClassify = messages[0].content.includes('Classify');
    if (isClassify) return { ok: true, content: '{"intent":"new_booking","confidence":0.95}' };
    if (user.includes('deluxe')) return { ok: true, content: '{"room_type":"deluxe"}' };
    if (user.includes('john')) return { ok: true, content: '{"guest_name":"John Roe"}' };
    if (user.includes('2026')) return { ok: true, content: '{"arrival":"2026-07-01","departure":"2026-07-03"}' };
    if (user.includes('adult')) return { ok: true, content: '{"adults":2}' };
    return { ok: true, content: '{}' };
  });
  const provider = buildLlmAiProvider({ transport: tx, secretProvider: fakeSecret, credentialsRef: 'r', tenantId: 't1' });
  const calls = [];
  const bs = { createBooking: async (b, c) => { calls.push(b); return { ok: true, reservation_id: 'res-1', pricing: { total: 230, currency: 'USD' } }; }, updateBooking: async () => ({ ok: true }), cancelBooking: async () => ({ ok: true }) };
  const a = buildAiAgentService({ bookingService: bs, provider, ctx: CTX });
  await a.handleMessage({ conversationId: 'c1', text: 'a deluxe room please' });
  await a.handleMessage({ conversationId: 'c1', text: 'name is John Roe' });
  await a.handleMessage({ conversationId: 'c1', text: 'from 2026-07-01 to 2026-07-03' });
  const done = await a.handleMessage({ conversationId: 'c1', text: '2 adults' });
  assert.equal(done.action, 'created');
  assert.equal(calls[0].room_type_id, 'rt-deluxe');
  assert.equal(calls[0].guest_name, 'John Roe');
  assert.equal(calls[0].adults, 2);
});

// 4. Low-confidence fallback
test('low confidence => deterministic rule fallback', async () => {
  const tx = scriptedTransport([{ ok: true, content: '{"intent":"cancel_booking","confidence":0.2}' }]);
  const p = buildLlmAiProvider({ transport: tx, secretProvider: fakeSecret, credentialsRef: 'r', tenantId: 't1', confidenceThreshold: 0.5 });
  const r = await p.classifyIntent('I want to book a room'); // rules say new_booking
  assert.equal(r.source, 'fallback');
  assert.equal(r.intent, 'new_booking'); // rule-based, not the low-confidence LLM 'cancel'
});

test('transport error / invalid intent => fallback', async () => {
  const txErr = scriptedTransport([{ ok: false, error: 'llm_http_500' }]);
  const p1 = buildLlmAiProvider({ transport: txErr, secretProvider: fakeSecret, credentialsRef: 'r' });
  assert.equal((await p1.classifyIntent('cancel res-1')).source, 'fallback');
  const txBad = scriptedTransport([{ ok: true, content: '{"intent":"not_a_real_intent","confidence":0.99}' }]);
  const p2 = buildLlmAiProvider({ transport: txBad, secretProvider: fakeSecret, credentialsRef: 'r' });
  assert.equal((await p2.classifyIntent('hello')).source, 'fallback');
});

// 5. Provider swap without agent changes
test('provider swap: agent runs identically with mock or llm provider', async () => {
  const tx = scriptedTransport((messages) => messages[0].content.includes('Classify')
    ? { ok: true, content: '{"intent":"new_booking","confidence":0.9}' }
    : { ok: true, content: '{"guest_name":"Ann Lee","room_type":"suite","arrival":"2026-09-01","departure":"2026-09-02","adults":1}' });
  const llm = buildLlmAiProvider({ transport: tx, secretProvider: fakeSecret, credentialsRef: 'r' });
  const calls = [];
  const bs = { createBooking: async (b) => { calls.push(b); return { ok: true, reservation_id: 'res-9' }; }, updateBooking: async () => ({ ok: true }), cancelBooking: async () => ({ ok: true }) };
  const a = buildAiAgentService({ bookingService: bs, provider: llm, ctx: CTX });
  const r = await a.handleMessage({ conversationId: 'c2', text: 'book a suite for Ann Lee 2026-09-01 to 2026-09-02 1 adult' });
  assert.equal(r.action, 'created');           // same agent code path as mock
  assert.equal(calls[0].guest_name, 'Ann Lee');
});

// Safety: HTTP transport disabled => no network, provider falls back
test('disabled HTTP transport makes no network call and the provider falls back to rules', async () => {
  let fetched = false;
  const tx = buildHttpLlmTransport({ enabled: false, endpoint: 'https://api.llm.test', fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({}) }; } });
  const p = buildLlmAiProvider({ transport: tx, secretProvider: fakeSecret, credentialsRef: 'r' });
  const r = await p.classifyIntent('cancel my booking');
  assert.equal(fetched, false);
  assert.equal(r.source, 'fallback');
  assert.equal(r.intent, 'cancel_booking');
});

// Safety: booking-critical replies are deterministic, never LLM
test('generateResponse uses deterministic template for booking-critical actions', async () => {
  const tx = scriptedTransport([{ ok: true, content: 'HALLUCINATED reference res-999' }]);
  const p = buildLlmAiProvider({ transport: tx, secretProvider: fakeSecret, credentialsRef: 'r' });
  const reply = await p.generateResponse({ intent: 'new_booking', action: 'created', result: { reservation_id: 'res-1', pricing: { total: 230, currency: 'USD' } } });
  assert.match(reply, /res-1/);
  assert.ok(!reply.includes('res-999'));       // LLM not consulted for confirmations
  assert.equal(tx.calls.length, 0);
});

// http transport enabled path uses a fake fetch only (no real network)
test('enabled HTTP transport calls the injected fetch (OpenAI-compatible), parses content', async () => {
  const fetchImpl = async (url, opts) => { fetchImpl.url = url; fetchImpl.auth = opts.headers.Authorization; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"intent":"rate_inquiry","confidence":0.8}' } }] }) }; };
  const tx = buildHttpLlmTransport({ enabled: true, endpoint: 'https://api.llm.test/v1/chat', fetchImpl });
  const p = buildLlmAiProvider({ transport: tx, secretProvider: fakeSecret, credentialsRef: 'k', tenantId: 't1' });
  const r = await p.classifyIntent('how much is a room');
  assert.equal(r.source, 'llm');
  assert.equal(r.intent, 'rate_inquiry');
  assert.equal(fetchImpl.url, 'https://api.llm.test/v1/chat');
  assert.equal(fetchImpl.auth, 'Bearer sk-k-t1');
});

// sanitize unit
test('sanitizeEntities coerces types and drops unknown keys', () => {
  assert.deepEqual(sanitizeEntities({ adults: '3', children: 'x', room_type: 'suite', nope: 1 }), { adults: 3, room_type: 'suite' });
});
