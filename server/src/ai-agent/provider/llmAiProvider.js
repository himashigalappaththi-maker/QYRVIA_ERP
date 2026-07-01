'use strict';

/**
 * llmAiProvider (Phase 27.1) - a REAL AIProvider backed by an LLM transport, with
 * SAFETY by construction:
 *   - API key resolved via the SecretProvider (B8-B1) by credentials_ref; never
 *     logged, never placed in the prompt body.
 *   - Output validation: intent must be in the allowed set and meet a confidence
 *     threshold; entities are sanitized to known typed slots.
 *   - Low-confidence / error / disabled-transport -> deterministic RULE fallback
 *     (the MockAIProvider), so a booking is never blocked by an LLM failure.
 *   - Booking-critical replies (confirmations / references) are ALWAYS rendered
 *     deterministically, never by the LLM (no hallucinated references).
 *
 * The agent is unchanged: it still calls classifyIntent / extractEntities /
 * generateResponse. Swapping mock <-> llm is config only.
 */

const { MockAIProvider, renderReply } = require('./mockProvider');
const { INTENTS } = require('../intentClassifier');

const ALLOWED_INTENTS = new Set(Object.values(INTENTS));
const ALLOWED_SLOTS = ['guest_name', 'arrival', 'departure', 'adults', 'children', 'room_type', 'booking_reference'];
const CRITICAL_ACTIONS = new Set(['created', 'updated', 'cancelled', 'collect', 'need_reference', 'rejected']);

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

function buildLlmAiProvider({ transport, secretProvider, credentialsRef, tenantId, confidenceThreshold = 0.5, fallback } = {}) {
  if (!transport) throw new Error('llmAiProvider: transport required');
  const fb = fallback || new MockAIProvider();

  async function resolveKey() {
    if (!secretProvider || !credentialsRef) return null;
    try { const s = await secretProvider.get(credentialsRef, { tenant_id: tenantId }); return (s && (s.api_key || s.token)) || null; }
    catch (_) { return null; }
  }
  async function ask(system, user) {
    const apiKey = await resolveKey();                                  // never logged / never in prompt
    return transport.chat([{ role: 'system', content: system }, { role: 'user', content: String(user || '') }], { apiKey });
  }

  return {
    kind: 'llm',
    async classifyIntent(text) {
      try {
        const r = await ask('Classify the hotel guest message intent. Reply ONLY JSON {"intent":one of new_booking|modify_booking|cancel_booking|availability_inquiry|rate_inquiry|unknown,"confidence":0..1}.', text);
        if (r && r.ok) {
          const j = extractJson(r.content);
          if (j && ALLOWED_INTENTS.has(j.intent) && Number(j.confidence) >= confidenceThreshold) {
            return { intent: j.intent, confidence: Number(j.confidence), source: 'llm' };
          }
        }
      } catch (_) { /* fall through to rules */ }
      const f = await fb.classifyIntent(text);
      return { intent: f.intent, confidence: f.confidence, source: 'fallback' };
    },

    async extractEntities(text) {
      try {
        const r = await ask('Extract booking slots from the message. Reply ONLY JSON using any of guest_name, arrival(YYYY-MM-DD), departure(YYYY-MM-DD), adults, children, room_type, booking_reference.', text);
        if (r && r.ok) { const j = extractJson(r.content); if (j) return sanitizeEntities(j); }
      } catch (_) { /* fall through to rules */ }
      return fb.extractEntities(text);
    },

    async generateResponse(ctx) {
      // Safety: booking-critical replies are deterministic (no LLM) so references/totals can't be hallucinated.
      if (ctx && CRITICAL_ACTIONS.has(ctx.action)) return renderReply(ctx);
      try {
        const r = await ask('You are a concise, friendly hotel booking assistant. Write one short helpful reply.', JSON.stringify({ intent: ctx && ctx.intent, action: ctx && ctx.action }));
        if (r && r.ok && r.content && String(r.content).trim()) return String(r.content).trim();
      } catch (_) { /* fall through */ }
      return renderReply(ctx);
    }
  };
}

module.exports = { buildLlmAiProvider, sanitizeEntities, extractJson, ALLOWED_SLOTS };
