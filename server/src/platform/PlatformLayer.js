'use strict';

/**
 * PlatformLayer (Phase 18) - facade composing the enterprise cross-cutting
 * layers: IAM, API gateway, observability, integration hub, and the
 * multi-property enterprise control layer. Self-contained; consumes the PMS
 * core only via events/APIs; never mutates it.
 */

const { buildRBACEngine } = require('./iam/RBACEngine');
const { buildPolicyEngine } = require('./iam/PolicyEngine');
const { buildAuthService } = require('./iam/AuthService');
const { buildRateLimiterEngine } = require('./gateway/RateLimiterEngine');
const { buildRequestContextEngine } = require('./gateway/RequestContextEngine');
const { buildAPIGateway } = require('./gateway/APIGateway');
const { buildLogEngine } = require('./observability/LogEngine');
const { buildMetricsEngine } = require('./observability/MetricsEngine');
const { buildTraceEngine } = require('./observability/TraceEngine');
const { buildAuditLogAggregator } = require('./observability/AuditLogAggregator');
const { buildIntegrationRegistry } = require('./integration/IntegrationRegistry');
const { buildIntegrationAdapterEngine } = require('./integration/IntegrationAdapterEngine');
const { buildWebhookEngine } = require('./integration/WebhookEngine');
const { buildPropertyRegistryEngine } = require('./enterprise/PropertyRegistryEngine');
const { buildEnterpriseConfigEngine } = require('./enterprise/EnterpriseConfigEngine');
const { buildCrossPropertyAnalyticsEngine } = require('./enterprise/CrossPropertyAnalyticsEngine');

function buildPlatformLayer({ clock, userProvider, businessDateProvider } = {}) {
  const rbac = buildRBACEngine();
  const policy = buildPolicyEngine({ rbac });
  const auth = buildAuthService({ userProvider, clock });
  const rateLimiter = buildRateLimiterEngine({ clock });
  const log = buildLogEngine({ clock });
  const metrics = buildMetricsEngine();
  const trace = buildTraceEngine({ clock });
  const audit = buildAuditLogAggregator({ clock });
  const context = buildRequestContextEngine({ businessDateProvider });
  const gateway = buildAPIGateway({ authService: auth, policyEngine: policy, rateLimiter, contextEngine: context, audit, log, trace });

  const integrations = buildIntegrationRegistry();
  const adapters = buildIntegrationAdapterEngine();
  const webhooks = buildWebhookEngine({ clock });

  const properties = buildPropertyRegistryEngine();
  const config = buildEnterpriseConfigEngine();
  const analytics = buildCrossPropertyAnalyticsEngine();

  return { rbac, policy, auth, rateLimiter, context, gateway, log, metrics, trace, audit,
    integrations, adapters, webhooks, properties, config, analytics };
}

module.exports = { buildPlatformLayer };
