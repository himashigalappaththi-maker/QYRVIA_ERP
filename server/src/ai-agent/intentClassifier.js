'use strict';

/**
 * intentClassifier (Phase 27) - deterministic, rule-based intent detection used
 * by the MockAIProvider. No external AI, no network. Order matters (cancel beats
 * modify beats rate/availability beats new booking).
 */

const INTENTS = Object.freeze({
  NEW: 'new_booking', MODIFY: 'modify_booking', CANCEL: 'cancel_booking',
  AVAILABILITY: 'availability_inquiry', RATE: 'rate_inquiry', UNKNOWN: 'unknown'
});

function classifyIntent(text) {
  const t = String(text || '').toLowerCase();
  if (/\bcancel\b/.test(t)) return INTENTS.CANCEL;
  if (/(change|modify|update|reschedul|move)\b/.test(t)) return INTENTS.MODIFY;
  if (/(rate|price|cost|how much|charge)/.test(t)) return INTENTS.RATE;
  if (/(availab|any room|free room|vacanc|do you have)/.test(t)) return INTENTS.AVAILABILITY;
  if (/(book|reserv|stay|room|night)/.test(t)) return INTENTS.NEW;
  return INTENTS.UNKNOWN;
}

module.exports = { classifyIntent, INTENTS };
