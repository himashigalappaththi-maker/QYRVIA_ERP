'use strict';

/**
 * nightAuditSubscriber - feeds the day-end activity tally from upstream events.
 * SUBSCRIBES read-only; never calls back into Billing / Front Desk /
 * Housekeeping. The tally drives default audit validation (e.g. open folios =
 * stays ended minus invoices finalized).
 */

function buildNightAuditSubscriber({ eventBus, repo } = {}) {
  if (!eventBus) throw new Error('nightAuditSubscriber: eventBus required');
  if (!repo) throw new Error('nightAuditSubscriber: repo required');

  const unsubs = [];
  const on = (type, key) => unsubs.push(eventBus.subscribe(type, async (e) => {
    try { if (e.property_id) await repo.bumpActivity(e.property_id, key); } catch (_) { /* isolated */ }
  }));

  on('stay.ended', 'staysEnded');
  on('invoice.finalized', 'invoicesFinalized');
  on('payment.received', 'paymentsReceived');
  on('housekeeping.task_completed', 'tasksCompleted');

  return function unsubscribe() { unsubs.forEach((u) => { try { u(); } catch (_) { /* ignore */ } }); };
}

module.exports = { buildNightAuditSubscriber };
