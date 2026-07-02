'use strict';

/** Phase 27.1A - multi-provider AI framework: registration, factory, failover, secrets, swap. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildProvider, buildAgentProvider, ROUTING_POLICY, preferredProviderForTask, validateConfig, KINDS } = require('../src/ai-agent/providers/ProviderFactory');
const { buildAnthropicProvider } = require('../src/ai-agent/providers/AnthropicProvider');
const { buildOpenAIProvider } = require('../src/ai-agent/providers/OpenAIProvider');
const { buildGeminiProvider } = require('../src/ai-agent/providers/GeminiProvider');
const { buildProviderFailoverChain } = require('../src/ai-agent/providers/ProviderFailoverChain');
const { MockProvider } = require('../src/ai-agent/providers/MockProvider');
const { buildAiAgentService } = require('../src/ai-agent/aiAgentService');

const fakeSecret = { async get(ref, { tenant_id }) { return { api_key: 'sk-' + ref + '-' + tenant_id }; } };
function okTransport(content) { const calls = []; return { calls, enabled: true, async chat(m, { apiKey } = {}) { calls.push({ m, apiKey }); return { ok: true, content }; } }; }
function downTransport() { return { enabled: true, async chat() { return { ok: false, error: 'http_500' }; } }; }

// 1-3. provider registration (each kind builds + advertises its name)
test('Anthropic / OpenAI / Gemini providers register with their kind', () => {
  assert.equal(buildAnthropicProvider({}).kind, 'anthropic');
  assert.equal(buildOpenAIProvider({}).kind, 'openai');
  assert.equal(buildGeminiProvider({}).kind, 'gemini');
});

// 4. provider factory selection
test('factory selects mock/anthropic/openai/gemini; unknown throws', () => {
  assert.equal(buildProvider('mock').kind, 'mock');
  assert.equal(buildProvider('anthropic', {}).kind, 'anthropic');
  assert.equal(buildProvider('openai', {}).kind, 'openai');
  assert.equal(buildProvider('gemini', {}).kind, 'gemini');
  assert.throws(() => buildProvider('llm'), /unknown_ai_provider/); // no generic 'llm'
  assert.deepEqual(KINDS, ['mock', 'anthropic', 'openai', 'gemini']);
});

// 5. failover chain (primary down -> next -> ... -> mock)
test('failover chain: a down provider is skipped and the next answers', async () => {
  const anthropic = buildAnthropicProvider({ transport: downTransport(), secretProvider: fakeSecret, credentialsRef: 'a' });
  const openai = buildOpenAIProvider({ transport: okTransport('{"intent":"new_booking","confidence":0.9}'), secretProvider: fakeSecret, credentialsRef: 'o' });
  const chain = buildProviderFailoverChain([anthropic, openai], { mock: new MockProvider() });
  const r = await chain.classifyIntent('book a room');
  assert.equal(r.source, 'openai');           // anthropic down -> openai answered
  assert.equal(r.intent, 'new_booking');
  assert.deepEqual(chain.order, ['anthropic', 'openai', 'mock']);
});

// 7. fallback to Mock when all vendors are unavailable
test('all vendors down => Mock answers (rules), no throw', async () => {
  const a = buildAnthropicProvider({ transport: downTransport(), secretProvider: fakeSecret, credentialsRef: 'a' });
  const o = buildOpenAIProvider({ transport: downTransport(), secretProvider: fakeSecret, credentialsRef: 'o' });
  const g = buildGeminiProvider({ transport: downTransport(), secretProvider: fakeSecret, credentialsRef: 'g' });
  const chain = buildProviderFailoverChain([a, o, g], { mock: new MockProvider() });
  const r = await chain.classifyIntent('cancel res-1'); // rules -> cancel
  assert.equal(r.source, 'rules');
  assert.equal(r.intent, 'cancel_booking');
});

// 6 & 9. SecretProvider integration + no secret leakage
test('SecretProvider key reaches the transport and never leaks into the prompt', async () => {
  const tx = okTransport('{"intent":"rate_inquiry","confidence":0.8}');
  const p = buildAnthropicProvider({ transport: tx, secretProvider: fakeSecret, credentialsRef: 'anthropic:p1', tenantId: 't1' });
  const r = await p.classifyIntent('how much for a suite');
  assert.equal(r.source, 'anthropic');
  assert.equal(tx.calls[0].apiKey, 'sk-anthropic:p1-t1');
  assert.ok(!JSON.stringify(tx.calls[0].m).includes('sk-'), 'key must not appear in prompt messages');
});

// 8. agent unchanged across providers
test('agent runs identically whether provider is mock, a vendor, or the chain', async () => {
  const calls = [];
  const bs = { createBooking: async (b) => { calls.push(b); return { ok: true, reservation_id: 'res-1', pricing: { total: 230, currency: 'USD' } }; }, updateBooking: async () => ({ ok: true }), cancelBooking: async () => ({ ok: true }) };
  const fullMsg = 'book a suite, my name is Ann Lee, from 2026-09-01 to 2026-09-02 for 2 adults';

  // (a) mock provider
  const aMock = buildAiAgentService({ bookingService: bs, provider: new MockProvider(), ctx: { tenantId: 't1' } });
  assert.equal((await aMock.handleMessage({ conversationId: 'm', text: fullMsg })).action, 'created');

  // (b) failover chain (vendors disabled -> mock) — same agent code path
  const chain = buildAgentProvider({}); // anthropic->openai->gemini->mock, all vendor transports disabled
  const aChain = buildAiAgentService({ bookingService: bs, provider: chain, ctx: { tenantId: 't1' } });
  assert.equal((await aChain.handleMessage({ conversationId: 'c', text: fullMsg })).action, 'created');
  assert.equal(calls.length, 2);
});

// default chain has no network when vendors are disabled
test('default agent provider chain makes no network call (vendors disabled)', async () => {
  const chain = buildAgentProvider({});
  assert.deepEqual(chain.order, ['anthropic', 'openai', 'gemini', 'mock']);
  const r = await chain.classifyIntent('book a room'); // all vendors disabled -> mock rules
  assert.equal(r.source, 'rules');
});

// 10. configuration validation + routing policy
test('config validation + hospitality routing policy', () => {
  assert.deepEqual(validateConfig({ primary: 'anthropic', fallback: 'openai', tertiary: 'gemini' }), { ok: true, invalid: [] });
  assert.equal(validateConfig({ primary: 'cohere' }).ok, false);
  assert.equal(ROUTING_POLICY.guest_conversation, 'anthropic');
  assert.equal(ROUTING_POLICY.forecasting, 'openai');
  assert.equal(ROUTING_POLICY.marketing_content, 'gemini');
  assert.equal(preferredProviderForTask('reservation_extraction'), 'anthropic');
  assert.equal(preferredProviderForTask('unknown_task'), 'anthropic');
});

// enabled vendor uses an injected fake fetch only (no real network)
test('enabled Anthropic transport uses injected fetch (x-api-key), parses content', async () => {
  const fetchImpl = async (url, opts) => { fetchImpl.url = url; fetchImpl.key = opts.headers['x-api-key']; return { ok: true, status: 200, json: async () => ({ content: [{ text: '{"intent":"new_booking","confidence":0.9}' }] }) }; };
  const { buildAnthropicTransport } = require('../src/ai-agent/providers/AnthropicProvider');
  const tx = buildAnthropicTransport({ enabled: true, endpoint: 'https://api.anthropic.test/v1/messages', fetchImpl });
  const p = buildAnthropicProvider({ transport: tx, secretProvider: fakeSecret, credentialsRef: 'k', tenantId: 't1' });
  const r = await p.classifyIntent('book a room');
  assert.equal(r.source, 'anthropic');
  assert.equal(fetchImpl.url, 'https://api.anthropic.test/v1/messages');
  assert.equal(fetchImpl.key, 'sk-k-t1');
});
