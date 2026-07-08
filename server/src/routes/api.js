'use strict';

const express = require('express');

const requestContext = require('../middleware/requestContext');
const tenantContext  = require('../middleware/tenantContext');
const { authentication }     = require('../middleware/authentication');
const { identityContext }    = require('../middleware/identityContext');
const { businessDateMiddleware } = require('../middleware/businessDate');

const healthRouter    = require('./health');
const coreRouter      = require('./core');
const connectorRouter = require('./connector');
const authRouterMod   = require('./auth');

// Phase 3 sub-routers
const settingsRouterMod      = require('./settings');
const filesRouterMod         = require('./files');
const connectorsRouterMod    = require('./connectors');
const webhooksRouterMod      = require('./webhooks');
const jobsRouterMod          = require('./jobs');
const notificationsRouterMod = require('./notifications');
const pmsRouterMod           = require('./pms');
const iamRouterMod           = require('./iam');
const financeRouterMod       = require('./finance');
const channelRouterMod       = require('../channel-manager/api/channel.routes');
const revenueRouterMod       = require('../revenue/api/revenue.routes');
const platformRouterMod      = require('../platform/api/platform.routes');
const bookingRouterMod       = require('../booking-engine/api/booking.routes');
const aiConfirmationRouterMod = require('../ai-confirmation/api/confirmation.routes');
const gatepasRouterMod        = require('./gatepass');
const posRouterMod            = require('./pos');

function build(deps = {}) {
  const router = express.Router();

  // Public: health (no auth, no tenant)
  router.use('/health',
    (req, _res, next) => { req._skipTenant = true; next(); },
    tenantContext,
    requestContext,
    healthRouter
  );

  // Public: auth
  router.use('/auth', authRouterMod.build(deps));

  // Protected: every /api/* below requires JWT + identityContext + businessDate
  const protectedChain = [
    authentication,
    identityContext(deps.identityRepo || {}),
    businessDateMiddleware(deps.identityRepo || {})
  ];
  router.use('/core',          ...protectedChain, coreRouter);
  router.use('/connector',     ...protectedChain, connectorRouter);

  // Phase 3 surfaces
  router.use('/settings',      ...protectedChain, settingsRouterMod.build(deps));
  router.use('/files',         ...protectedChain, filesRouterMod.build(deps));
  router.use('/connectors',    ...protectedChain, connectorsRouterMod.build(deps));
  router.use('/webhooks',      ...protectedChain, webhooksRouterMod.build(deps));
  router.use('/jobs',          ...protectedChain, jobsRouterMod.build(deps));
  router.use('/notifications', ...protectedChain, notificationsRouterMod.build(deps));
  router.use('/pms',           ...protectedChain, pmsRouterMod.build(deps));
  router.use('/iam',           ...protectedChain, iamRouterMod.build(deps));
  router.use('/finance',       ...protectedChain, financeRouterMod.build(deps));
  router.use('/channel',       ...protectedChain, channelRouterMod.build(deps));
  router.use('/revenue',       ...protectedChain, revenueRouterMod.build(deps));
  router.use('/platform',      ...protectedChain, platformRouterMod.build(deps));
  router.use('/booking',       ...protectedChain, bookingRouterMod.build(deps)); // Phase 26: official reservation entry
  router.use('/ai-confirmation', ...protectedChain, aiConfirmationRouterMod.build(deps)); // Phase 27.3: confirmation pipeline (empty router when OFF)
  router.use('/gatepass',       ...protectedChain, gatepasRouterMod.build(deps));        // Phase 46B: agent-isolated gate passes
  router.use('/pos',            ...protectedChain, posRouterMod.build(deps));            // Phase 46B: agent-isolated POS orders

  return router;
}

module.exports = { build };
