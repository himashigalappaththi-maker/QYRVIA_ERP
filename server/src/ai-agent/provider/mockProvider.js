'use strict';

/**
 * AIProvider interface + MockAIProvider (Phase 27). The agent depends only on the
 * interface; concrete providers (mock here, real LLM in 27.1) are swapped by config.
 * MockAIProvider is deterministic (rule-based classifier/extractor + templated NLG)
 * and also serves as the LLM provider's safe FALLBACK.
 */

const { classifyIntent } = require('../intentClassifier');
const { extractEntities } = require('../entityExtractor');

class AIProvider {
  async classifyIntent() { throw new Error('not_implemented: classifyIntent'); }
  async extractEntities() { throw new Error('not_implemented: extractEntities'); }
  async generateResponse() { throw new Error('not_implemented: generateResponse'); }
}

const ASK = {
  guest_name: 'May I have the guest name for the booking?',
  room_type:  'What room type would you like (e.g. deluxe, suite, standard)?',
  arrival:    'What is your arrival date? (YYYY-MM-DD)',
  departure:  'What is your departure date? (YYYY-MM-DD)',
  adults:     'How many adults will be staying?'
};

function renderReply({ intent, action, missing, result, state } = {}) {
  const s = state || {};
  if (action === 'collect' && missing) return ASK[missing] || 'Could you share a few more details?';
  if (action === 'created' && result) return `Your booking is confirmed ✅ Reference ${result.reservation_id}` + (result.pricing ? ` — total ${result.pricing.total} ${result.pricing.currency}` : '') + '. Thank you!';
  if (action === 'updated' && result) return `Your booking ${result.reservation_id || ''} has been updated. ✅`;
  if (action === 'cancelled') return 'Your booking has been cancelled. We hope to host you another time.';
  if (action === 'need_reference') return 'Could you share your booking reference (e.g. res-123)?';
  if (action === 'rejected') return `Sorry, I couldn't complete that: ${(result && result.reason) || 'please check the details'}.`;
  if (intent === 'availability_inquiry') return `We have availability${s.room_type ? ' for ' + s.room_type + ' rooms' : ''}${s.arrival ? ' from ' + s.arrival : ''}. Would you like to book?`;
  if (intent === 'rate_inquiry') return `Our ${s.room_type ? s.room_type + ' ' : ''}rooms are available at our standard nightly rate. Would you like a quote or to book?`;
  if (intent === 'unknown') return 'I can help you book a stay, change or cancel a booking, or check availability and rates. What would you like to do?';
  return 'How can I help with your stay?';
}

class MockAIProvider extends AIProvider {
  constructor() { super(); this.kind = 'mock'; }
  async classifyIntent(text) { return { intent: classifyIntent(text), confidence: 1, source: 'rules' }; }
  async extractEntities(text) { return extractEntities(text); }
  async generateResponse(ctx) { return renderReply(ctx); }
}

module.exports = { AIProvider, MockAIProvider, renderReply, ASK };
