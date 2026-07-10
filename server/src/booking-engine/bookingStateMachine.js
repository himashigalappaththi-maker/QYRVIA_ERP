'use strict';

const BOOKING_STATES = Object.freeze({
  DRAFT:           'draft',
  PENDING_PAYMENT: 'pending_payment',
  CONFIRMED:       'confirmed',
  PAYMENT_FAILED:  'payment_failed',
  CANCELLED:       'cancelled',
});

// Each transition: from state + trigger → to state + flags
const TRANSITIONS = Object.freeze([
  {
    from: 'draft',           trigger: 'initiate_payment',  to: 'pending_payment',
    requiresInventoryCheck: true,  requiresPaymentCall: true,
  },
  {
    from: 'pending_payment', trigger: 'payment_confirmed', to: 'confirmed',
    requiresInventoryCheck: true,  requiresPaymentCall: false,
  },
  {
    from: 'pending_payment', trigger: 'payment_failed',    to: 'payment_failed',
    requiresInventoryCheck: false, requiresPaymentCall: false,
  },
  {
    from: 'pending_payment', trigger: 'hold_expired',      to: 'cancelled',
    requiresInventoryCheck: false, requiresPaymentCall: false,
  },
  {
    from: 'draft',           trigger: 'cancel',            to: 'cancelled',
    requiresInventoryCheck: false, requiresPaymentCall: false,
  },
  {
    from: 'payment_failed',  trigger: 'cancel',            to: 'cancelled',
    requiresInventoryCheck: false, requiresPaymentCall: false,
  },
  {
    from: 'confirmed',       trigger: 'cancel',            to: 'cancelled',
    requiresInventoryCheck: false, requiresPaymentCall: true,
  },
]);

// Build lookup: { 'draft::initiate_payment': transition, ... }
const _lookup = new Map(
  TRANSITIONS.map(t => [`${t.from}::${t.trigger}`, t])
);

function getTransition(fromState, trigger) {
  return _lookup.get(`${fromState}::${trigger}`) || null;
}

function isValidTransition(fromState, trigger) {
  return _lookup.has(`${fromState}::${trigger}`);
}

function getAllowedTriggers(fromState) {
  return TRANSITIONS.filter(t => t.from === fromState).map(t => t.trigger);
}

module.exports = { BOOKING_STATES, TRANSITIONS, getTransition, isValidTransition, getAllowedTriggers };
