'use strict';

/**
 * AI Booking Confirmation routes (Phase 27.3) - mounted at /api/ai-confirmation.
 * Read + operational surface over the confirmation pipeline. Reuses the reserved
 * AI permissions (no new permission codes / no migration): reads need
 * 'ai.conversation.read'; operational actions need 'ai.whatsapp.config'.
 *
 * Gated: when AI_CONFIRMATION_ENABLED=false, deps.aiConfirmation is null and this
 * returns an empty router (the routes simply do not exist).
 */

const express = require('express');
const { requirePermission } = require('../../middleware/authorization');
const { buildConfirmationHandlers } = require('./confirmationHandlers');

function build(deps = {}) {
  const router = express.Router();
  if (!deps.aiConfirmation || !deps.aiConfirmation.service) return router; // graceful: confirmation OFF
  const h = buildConfirmationHandlers({ aiConfirmation: deps.aiConfirmation });

  router.get('/status',       requirePermission('ai.conversation.read'), h.status);
  router.get('/escalations',  requirePermission('ai.conversation.read'), h.escalations);
  router.get('/dead-letter',  requirePermission('ai.conversation.read'), h.deadLetter);
  router.post('/drain',       requirePermission('ai.whatsapp.config'),   h.drain);
  router.post('/replay',      requirePermission('ai.whatsapp.config'),   h.replay);

  return router;
}

module.exports = { build };
