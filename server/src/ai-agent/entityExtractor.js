'use strict';

/**
 * entityExtractor (Phase 27) - deterministic, rule-based slot extraction used by
 * the MockAIProvider. Pulls guest_name, arrival/departure (ISO dates), occupancy,
 * room_type, and booking_reference from a message. No external AI, no network.
 */

const ROOM_TYPES = ['deluxe', 'suite', 'standard', 'double', 'single', 'twin', 'family', 'executive'];

function extractEntities(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  const e = {};

  const dates = t.match(/\d{4}-\d{2}-\d{2}/g) || [];
  if (dates[0]) e.arrival = dates[0];
  if (dates[1]) e.departure = dates[1];

  const ad = lower.match(/(\d+)\s*(adult|guest|people|person|pax)/);
  if (ad) e.adults = Number(ad[1]);
  const ch = lower.match(/(\d+)\s*(child|children|kid)/);
  if (ch) e.children = Number(ch[1]);

  const rt = ROOM_TYPES.find((r) => new RegExp('\\b' + r + '\\b').test(lower));
  if (rt) e.room_type = rt;

  const nm = t.match(/(?:name is|i am|i'm|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (nm) e.guest_name = nm[1].trim();

  const ref = t.match(/\b(res-[A-Za-z0-9-]+)\b/i) || t.match(/(?:reference|ref|booking)\s*[:#]?\s*([A-Za-z0-9-]{4,})/i);
  if (ref) e.booking_reference = ref[1];

  return e;
}

module.exports = { extractEntities, ROOM_TYPES };
