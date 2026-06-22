'use strict';

/**
 * Connector registry.
 *
 *   list(ctx)                           -> [{ id, code, label, type, is_active }]
 *   getConfig(connectorCode, ctx)       -> { enabled, config_json } | null
 *   configureConnector(connectorCode, { enabled, config_json }, ctx)  -> { ok }   audited
 *   probeConnector(connectorCode, ctx)  -> { status, detail }                     audited (probe log)
 *   healthCheck(connectorCode, ctx)     -> { status, detail, latency_ms }         audited (health log)
 *
 * No real third-party calls in Phase 3. probe + health return 'not_configured'
 * when no config row exists, and 'configured' (probe) / 'unknown' (health)
 * when a config row exists. Real provider implementations land in a later phase
 * by registering a probe/health adapter via registerAdapter.
 */

const { makeEvent } = require('../core/event');
const eventBus      = require('../core/eventBus');
const logger        = require('../config/logger');

function buildConnectorRegistry({ repo }) {
  if (!repo) throw new Error('buildConnectorRegistry: repo required');
  const adapters = new Map(); // code -> { probe(cfg), health(cfg) }

  function registerAdapter(connectorCode, adapter) {
    adapters.set(connectorCode, adapter);
  }

  async function list(ctx) {
    return repo.listConnectors();
  }

  async function getConfig(connectorCode, ctx) {
    if (!ctx || !ctx.tenantId) return null;
    return repo.findConnectorConfig(ctx.tenantId, ctx.propertyId || null, connectorCode);
  }

  async function configureConnector(connectorCode, { enabled, config_json }, ctx) {
    if (!ctx || !ctx.tenantId) return { ok: false, error: 'tenant_required' };
    const connector = await repo.findConnectorByCode(connectorCode);
    if (!connector) return { ok: false, error: 'connector_not_found' };
    await repo.upsertConnectorConfig({
      tenant_id:     ctx.tenantId,
      property_id:   ctx.propertyId || null,
      connector_id:  connector.id,
      enabled:       !!enabled,
      config_json:   config_json || {},
      configured_by: ctx.actorId || null
    });
    try {
      await eventBus.publish(makeEvent({
        type:          'connector.configured',
        aggregateType: 'connector',
        aggregateId:   connectorCode,
        payload: {
          connector_code: connectorCode, enabled: !!enabled,
          actor_name:     ctx.actorName || null
        },
        ctx
      }));
    } catch (e) { logger.error({ err: e }, '[connectors] audit publish failed'); }
    return { ok: true };
  }

  async function probeConnector(connectorCode, ctx) {
    if (!ctx || !ctx.tenantId) return { status: 'not_configured', detail: 'tenant_required' };
    const connector = await repo.findConnectorByCode(connectorCode);
    if (!connector) return { status: 'not_configured', detail: 'connector_not_found' };
    const cfg = await repo.findConnectorConfig(ctx.tenantId, ctx.propertyId || null, connectorCode);
    let status, detail = null, latency = null;
    if (!cfg || !cfg.enabled) {
      status = 'not_configured';
    } else {
      const adapter = adapters.get(connectorCode);
      if (!adapter || typeof adapter.probe !== 'function') {
        status = 'configured';   // we know it's configured; we just can't call the third-party from Phase 3
        detail = 'adapter_not_registered';
      } else {
        const t0 = Date.now();
        try { const r = await adapter.probe(cfg.config_json); status = r.ok ? 'configured' : 'not_configured'; detail = r.detail || null; }
        catch (err) { status = 'unreachable'; detail = String(err.message || err); }
        latency = Date.now() - t0;
      }
    }
    await repo.insertConnectorHealthLog({
      tenant_id: ctx.tenantId, connector_id: connector.id,
      kind: 'probe', status, detail, latency_ms: latency
    });
    return { status, detail, latency_ms: latency };
  }

  async function healthCheck(connectorCode, ctx) {
    if (!ctx || !ctx.tenantId) return { status: 'unhealthy', detail: 'tenant_required' };
    const connector = await repo.findConnectorByCode(connectorCode);
    if (!connector) return { status: 'unhealthy', detail: 'connector_not_found' };
    const cfg = await repo.findConnectorConfig(ctx.tenantId, ctx.propertyId || null, connectorCode);
    let status, detail = null, latency = null;
    if (!cfg || !cfg.enabled) {
      status = 'not_configured';
    } else {
      const adapter = adapters.get(connectorCode);
      if (!adapter || typeof adapter.health !== 'function') {
        status = 'unknown';
        detail = 'adapter_not_registered';
      } else {
        const t0 = Date.now();
        try { const r = await adapter.health(cfg.config_json); status = r.ok ? 'healthy' : 'unhealthy'; detail = r.detail || null; }
        catch (err) { status = 'unreachable'; detail = String(err.message || err); }
        latency = Date.now() - t0;
      }
    }
    await repo.insertConnectorHealthLog({
      tenant_id: ctx.tenantId, connector_id: connector.id,
      kind: 'health', status, detail, latency_ms: latency
    });
    return { status, detail, latency_ms: latency };
  }

  return { list, getConfig, configureConnector, probeConnector, healthCheck, registerAdapter };
}

module.exports = { buildConnectorRegistry };
