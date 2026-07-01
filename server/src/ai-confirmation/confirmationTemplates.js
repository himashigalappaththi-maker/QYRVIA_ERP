'use strict';

/**
 * confirmationTemplates (Phase 27.3) - DETERMINISTIC, system-rendered confirmation
 * messages. There is NO LLM here: booking references, amounts and dates are always
 * rendered by the system (honours the "references never LLM-rendered" guarantee).
 *
 * A template is a pure function of the booking event fields; missing fields degrade
 * gracefully (e.g. "there" when no guest name is present). Templates are keyed by
 * event type, then locale, with 'en' as the fallback locale.
 */

function line(parts) { return parts.filter((p) => p != null && p !== '').join('\n'); }
function money(b) { return b.total != null ? `Total: ${b.total} ${b.currency || ''}`.trim() : null; }
function stay(b) { return (b.arrival && b.departure) ? `Stay: ${b.arrival} -> ${b.departure}` : null; }
function ref(b) { return `Reference: ${b.reservation_id || '(pending)'}`; }

const TEMPLATES = {
  'booking.created': {
    en: (b) => line([
      `Hi ${b.guest || 'there'}, your booking is confirmed.`,
      ref(b), stay(b), money(b),
      'We look forward to hosting you. Reply here if you need anything.'
    ])
  },
  'booking.updated': {
    en: (b) => line([
      `Hi ${b.guest || 'there'}, your booking has been updated.`,
      ref(b), stay(b), money(b),
      'Please review the new details above. Reply here with any questions.'
    ])
  },
  'booking.cancelled': {
    en: (b) => line([
      `Hi ${b.guest || 'there'}, your booking has been cancelled.`,
      ref(b),
      'We hope to welcome you another time. Reply here if this was a mistake.'
    ])
  }
};

/** True when an event type has a confirmation template (i.e. is a guest-facing outcome). */
function hasTemplate(type) { return Object.prototype.hasOwnProperty.call(TEMPLATES, type); }

/** Render a confirmation message for an event, or null if the type is unsupported. */
function renderConfirmation(event, { locale = 'en' } = {}) {
  const ev = event || {};
  const tpl = TEMPLATES[ev.type];
  if (!tpl) return null;
  const fn = tpl[locale] || tpl.en;
  return fn({
    guest: ev.guest_name,
    reservation_id: ev.reservation_id,
    arrival: ev.arrival,
    departure: ev.departure,
    total: ev.total,
    currency: ev.currency
  });
}

function listTemplates() { return Object.keys(TEMPLATES); }

module.exports = { renderConfirmation, hasTemplate, listTemplates, TEMPLATES };
