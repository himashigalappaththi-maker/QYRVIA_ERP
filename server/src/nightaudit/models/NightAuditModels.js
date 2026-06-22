'use strict';

/**
 * Night Audit / Business Date models (Phase 16). Additive / self-contained;
 * JS / CommonJS. Deterministic - no AI.
 */

const crypto = require('crypto');

const DATE_STATUS = Object.freeze({ OPEN: 'OPEN', AUDIT_PENDING: 'AUDIT_PENDING', CLOSED: 'CLOSED' });
const RUN_STATUS = Object.freeze({ RUNNING: 'RUNNING', COMPLETED: 'COMPLETED', FAILED: 'FAILED', ROLLED_BACK: 'ROLLED_BACK' });
const LOCK_STATUS = Object.freeze({ LOCKED: 'LOCKED', UNLOCKED: 'UNLOCKED' });
const EXCEPTION_CATEGORY = Object.freeze({ FINANCIAL: 'FINANCIAL', OPERATIONAL: 'OPERATIONAL', BILLING: 'BILLING', SYSTEM: 'SYSTEM' });

/** 'YYYY-MM-DD' + 1 day. */
function nextDate(dateStr) {
  const d = new Date(String(dateStr) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function makeBusinessDate(f = {}) {
  if (!f.propertyId) throw new Error('BusinessDate: propertyId required');
  if (!f.currentBusinessDate) throw new Error('BusinessDate: currentBusinessDate required');
  return {
    propertyId: String(f.propertyId),
    currentBusinessDate: f.currentBusinessDate,
    status: f.status || DATE_STATUS.OPEN,
    lastClosedDate: f.lastClosedDate || null,
    lastAuditAt: f.lastAuditAt || null,
    auditUserId: f.auditUserId || null
  };
}

function makeRun(f = {}) {
  if (!f.propertyId) throw new Error('NightAuditRun: propertyId required');
  if (!f.businessDate) throw new Error('NightAuditRun: businessDate required');
  return {
    id: f.id || crypto.randomUUID(),
    propertyId: String(f.propertyId),
    businessDate: f.businessDate,
    startedAt: f.startedAt || new Date().toISOString(),
    completedAt: null,
    status: f.status || RUN_STATUS.RUNNING,
    warnings: f.warnings || [],
    exceptions: f.exceptions || [],
    summary: f.summary || null
  };
}

function makeLock(f = {}) {
  if (!f.propertyId) throw new Error('FinancialLock: propertyId required');
  return {
    propertyId: String(f.propertyId),
    businessDate: f.businessDate || null,
    lockStatus: f.lockStatus || LOCK_STATUS.UNLOCKED,
    lockedModules: f.lockedModules || [],
    createdAt: new Date().toISOString()
  };
}

module.exports = { DATE_STATUS, RUN_STATUS, LOCK_STATUS, EXCEPTION_CATEGORY, nextDate, makeBusinessDate, makeRun, makeLock };
