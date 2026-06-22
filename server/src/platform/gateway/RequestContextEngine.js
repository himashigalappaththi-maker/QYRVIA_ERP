'use strict';

/**
 * RequestContextEngine (Phase 18) - assembles the canonical request context
 * injected into every governed request: userId, propertyId, role(s), requestId,
 * sessionId, and businessDate (resolved from Night Audit, read-only).
 */

const crypto = require('crypto');

function buildRequestContextEngine({ businessDateProvider, idGen } = {}) {
  const newId = idGen || (() => crypto.randomUUID());

  async function build({ principal = {}, propertyId, requestId, sessionId } = {}) {
    let businessDate = null;
    if (businessDateProvider && propertyId) {
      try {
        const bd = await businessDateProvider({ propertyId });
        businessDate = bd && (bd.currentBusinessDate || bd.businessDate || bd) || null;
      } catch (_) { businessDate = null; }
    }
    return {
      userId: principal.userId || null,
      propertyId: propertyId || null,
      roles: principal.roles || [],
      requestId: requestId || newId(),
      sessionId: sessionId || null,
      businessDate
    };
  }

  return { build };
}

module.exports = { buildRequestContextEngine };
