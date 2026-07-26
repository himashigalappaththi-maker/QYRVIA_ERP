'use strict';

/**
 * Phase 64 — mark a command (or query) list as tenant-scoped.
 *
 * Every PMS, folio, housekeeping, night-audit and payment-allocation command
 * writes to a table with FORCE ROW LEVEL SECURITY and an `app.tenant_id`
 * policy, so every one of them must execute inside a tenant-bound unit of work.
 * Stamping the whole list is deliberate: an opt-in-per-command approach means a
 * command added later silently defaults to the UNBOUND behaviour that was
 * P0-11. Here the default is bound, and an exception has to be argued for.
 *
 * `transactionMode` defaults to 'write' for commands. Query lists pass 'read'.
 */

const VALID_MODES = new Set(['read', 'write']);

/**
 * @param {object[]} list  command or query records
 * @param {'read'|'write'} [mode='write']
 * @returns {object[]} the same records, each stamped tenantScoped + transactionMode
 */
function asTenantScoped(list, mode = 'write') {
  if (!Array.isArray(list)) throw new Error('asTenantScoped: an array is required');
  if (!VALID_MODES.has(mode)) throw new Error('asTenantScoped: mode must be "read" or "write"');
  return list.map((record) => {
    if (!record || typeof record !== 'object') {
      throw new Error('asTenantScoped: every entry must be a command/query record');
    }
    // A record may opt out explicitly (e.g. a genuinely cross-tenant platform
    // operation). It must say so on itself — silence means scoped.
    if (record.tenantScoped === false) return record;
    return Object.assign({}, record, {
      tenantScoped: true,
      transactionMode: record.transactionMode || mode
    });
  });
}

module.exports = { asTenantScoped };
