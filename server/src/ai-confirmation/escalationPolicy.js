'use strict';

/**
 * escalationPolicy (Phase 27.3) - the deterministic decision tree that decides what
 * happens to a booking event:
 *
 *   suppress      - nothing guest-facing (rejections, unsupported event types)
 *   escalate      - hand to a human (no recipient, low AI confidence, or manual mode)
 *   auto_confirm  - render + enqueue an automatic confirmation
 *
 * Pure function, no side effects. The reasons array explains the decision (audit/UX).
 */

const CONFIRMABLE = new Set(['booking.created', 'booking.updated', 'booking.cancelled']);

function decideConfirmation(event, { recipient, confidence = 1, autoSend = true, minConfidence = 0.5 } = {}) {
  const type = event && event.type;

  // Rejections + anything without a guest-facing template never message the guest.
  if (type === 'booking.rejected') return { decision: 'suppress', reasons: ['booking_rejected'] };
  if (!CONFIRMABLE.has(type))      return { decision: 'suppress', reasons: ['unsupported_event'] };

  // From here the outcome is confirmable; decide auto vs. human.
  if (!recipient)                  return { decision: 'escalate', reasons: ['no_recipient'] };
  if (Number(confidence) < Number(minConfidence)) return { decision: 'escalate', reasons: ['low_confidence'] };
  if (!autoSend)                   return { decision: 'escalate', reasons: ['manual_approval_mode'] };

  return { decision: 'auto_confirm', reasons: ['auto'] };
}

module.exports = { decideConfirmation, CONFIRMABLE };
