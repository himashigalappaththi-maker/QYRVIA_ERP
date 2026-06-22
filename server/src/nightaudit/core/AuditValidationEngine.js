'use strict';

/**
 * AuditValidationEngine - readiness checks for day-end. Deterministic.
 *
 * Data comes from injectable provider functions (wired to Billing read-ports
 * in production) and falls back to the event-fed activity tally on the repo.
 * Returns { blocking[], warnings[] } - blocking errors prevent the audit from
 * advancing the business date.
 *
 * Checks: open folios, invoice balance violations, unposted charges, incomplete
 * financial postings, unresolved (blocking) exceptions.
 */

function buildAuditValidationEngine({ repo } = {}) {
  if (!repo) throw new Error('AuditValidationEngine: repo required');
  const requireProperty = (ctx) => { if (!ctx || !ctx.propertyId) throw new Error('property_required'); return ctx.propertyId; };
  const num = async (p, fallback) => {
    if (typeof p === 'function') { const v = await p(); return Array.isArray(v) ? v.length : Number(v) || 0; }
    return fallback;
  };

  return {
    async validate(ctx, { providers = {} } = {}) {
      const propertyId = requireProperty(ctx);
      const activity = await repo.getActivity(propertyId);

      const openFolios = await num(providers.listOpenFolios, Math.max(0, activity.staysEnded - activity.invoicesFinalized));
      const unbalancedInvoices = await num(providers.listUnbalancedInvoices, 0);
      const unpostedCharges = await num(providers.listUnpostedCharges, 0);
      const incompletePostings = await num(providers.listIncompletePostings, 0);

      // Only EXTERNALLY-raised blocking exceptions block the audit. Audit-derived
      // (source VALIDATION) exceptions are an audit trail and are re-evaluated on
      // each run, so they never perma-block a retry once the cause is fixed.
      const unresolved = (await repo.listExceptions(propertyId, { resolved: false }))
        .filter((e) => e.blocking && e.source !== 'VALIDATION');

      const blocking = [];
      const warnings = [];

      if (openFolios > 0) blocking.push({ code: 'open_folios', category: 'BILLING', count: openFolios, message: openFolios + ' open folio(s) must be settled' });
      if (unbalancedInvoices > 0) blocking.push({ code: 'invoice_balance_violations', category: 'FINANCIAL', count: unbalancedInvoices, message: 'unbalanced invoices present' });
      if (incompletePostings > 0) blocking.push({ code: 'incomplete_postings', category: 'FINANCIAL', count: incompletePostings, message: 'incomplete financial postings' });
      if (unresolved.length > 0) blocking.push({ code: 'unresolved_exceptions', category: 'SYSTEM', count: unresolved.length, message: 'unresolved blocking exceptions' });

      if (unpostedCharges > 0) warnings.push({ code: 'unposted_charges', category: 'BILLING', count: unpostedCharges, message: 'unposted charges (non-blocking)' });

      return { blocking, warnings, ok: blocking.length === 0 };
    }
  };
}

module.exports = { buildAuditValidationEngine };
