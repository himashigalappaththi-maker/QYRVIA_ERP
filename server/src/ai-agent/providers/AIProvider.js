'use strict';

/**
 * AIProvider base + shared vendor engine (Phase 27.1A). Vendor providers
 * (Anthropic / OpenAI / Gemini) share this scaffolding: SecretProvider key
 * resolution, output validation, entity sanitization. On ANY failure (disabled
 * transport / HTTP error / low confidence / invalid output) a vendor method
 * THROWS ProviderUnavailable so the failover chain can try the next provider.
 * The key is resolved at execution time, never logged, never put in the prompt.
 */

const { INTENTS } = require('../intentClassifier');

const ALLOWED_INTENTS = new Set(Object.values(INTENTS));
const ALLOWED_SLOTS = ['guest_name', 'arrival', 'departure', 'adults', 'children', 'room_type', 'booking_reference'];

class AIProvider {
  async classifyIntent() { throw new Error('not_implemented: classifyIntent'); }
  async extractEntities() { throw new Error('not_implemented: extractEntities'); }
  async generateResponse() { throw new Error('not_implemented: generateResponse'); }
}

class ProviderUnavailable extends Error {
  constructor(provider, reason) { super('provider_unavailable:' + provider + (reason ? ':' + reason : '')); this.provider = provider; this.reason = reason; }
}

function extractJson(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

function sanitizeEntities(obj) {
  const e = {};
  if (!obj || typeof obj !== 'object') return e;
  for (const k of ALLOWED_SLOTS) {
    if (obj[k] == null || obj[k] === '') continue;
    if (k === 'adults' || k === 'children') { const n = Number(obj[k]); if (Number.isFinite(n)) e[k] = n; }
    else e[k] = String(obj[k]);
  }
  return e;
}

async function resolveKey({ secretProvider, credentialsRef, tenantId }) {
  if (!secretProvider || !credentialsRef) return null;
  try { const s = await secretProvider.get(credentialsRef, { tenant_id: tenantId }); return (s && (s.api_key || s.token)) || null; }
  catch (_) { return null; }
}

function buildVendorProvider({ name, transport, secretProvider, credentialsRef, tenantId, confidenceThreshold = 0.5 }) {
  if (!transport) throw new Error('buildVendorProvider: transport required');
  async function ask(system, user) {
    const apiKey = await resolveKey({ secretProvider, credentialsRef, tenantId });   // execution-time only
    const r = await transport.chat([{ role: 'system', content: system }, { role: 'user', content: String(user || '') }], { apiKey });
    if (!r || !r.ok) throw new ProviderUnavailable(name, r && r.error);
    return r.content;
  }
  return {
    kind: name, name,
    async classifyIntent(text) {
      const j = extractJson(await ask('Classify the hotel guest message intent. Reply ONLY JSON {"intent":one of new_booking|modify_booking|cancel_booking|availability_inquiry|rate_inquiry|unknown,"confidence":0..1}.', text));
      if (!j || !ALLOWED_INTENTS.has(j.intent) || Number(j.confidence) < confidenceThreshold) throw new ProviderUnavailable(name, 'low_confidence_or_invalid');
      return { intent: j.intent, confidence: Number(j.confidence), source: name };
    },
    async extractEntities(text) {
      const j = extractJson(await ask('Extract booking slots. Reply ONLY JSON using any of guest_name, arrival(YYYY-MM-DD), departure, adults, children, room_type, booking_reference.', text));
      if (!j) throw new ProviderUnavailable(name, 'no_json');
      return sanitizeEntities(j);
    },
    async generateResponse(ctx) {
      const content = await ask('You are a concise, friendly hotel booking assistant. Write one short helpful reply.', JSON.stringify({ intent: ctx && ctx.intent, action: ctx && ctx.action }));
      if (!content || !String(content).trim()) throw new ProviderUnavailable(name, 'empty');
      return String(content).trim();
    }
  };
}

module.exports = { AIProvider, ProviderUnavailable, buildVendorProvider, extractJson, sanitizeEntities, resolveKey, ALLOWED_SLOTS, ALLOWED_INTENTS };
