'use strict';

/**
 * Phase 64 — tenant-bound audit / domain-event writers.
 *
 * WHY
 * ───
 * `audit_events` carries ENABLE + FORCE ROW LEVEL SECURITY with an
 * `app.tenant_id` policy (0001_init.sql:78-81, rewritten by 0004_rls_policies)
 * and so does `event_store` (0006_event_store.sql). The dbFacade in
 * src/index.js wrote to BOTH through a bare `obsPool.query`, which is the same
 * P0-11 defect as the PMS repositories: with no tenant bound, every insert
 * fails its policy WITH CHECK under a NOBYPASSRLS role. The audit trail — the
 * one thing that is supposed to survive everything — was the least durable part
 * of the system.
 *
 * TRANSACTION PLACEMENT — deliberate
 * ──────────────────────────────────
 * When a command's unit of work is already open, these writers JOIN it, so a
 * domain event and the state change it describes commit or roll back together.
 *
 * When no unit of work is open, each writer opens its OWN short transaction
 * bound to the event's own tenant_id. That is the correct behaviour for the
 * audit pipeline's `command.attempted` / `command.succeeded` / `command.failed`
 * rows: they are published outside the command transaction ON PURPOSE, so that
 * a ROLLED-BACK command still leaves an audit trail. An audit record that
 * vanishes with the failure it was recording is worthless.
 *
 * The tenant comes from `ev.tenant_id`, which the event factory
 * (src/core/event.js) copies from the trusted request context — never from
 * client input.
 */

const { hasTenantContext, getTenantId, getTenantClient, runWithTenantTransaction } =
  require('./tenantUnitOfWork');

const AUDIT_SQL = `
  INSERT INTO audit_events
    (event_id, event_type, aggregate_type, aggregate_id,
     tenant_id, property_id, actor_id, request_id, payload, occurred_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

/**
 * @param {object} deps
 * @param {object} deps.pool               pg Pool (or instrumented wrapper) with connect()
 * @param {Function} deps.domainEventWriter  (queryable) => insertDomainEvent(ev)
 *                                           i.e. buildDomainEventWriter from core/eventStoreWriter
 */
function buildTenantBoundEventWriters({ pool, domainEventWriter }) {
  if (!pool) throw new Error('buildTenantBoundEventWriters: pool is required');
  if (typeof domainEventWriter !== 'function') {
    throw new Error('buildTenantBoundEventWriters: domainEventWriter factory is required');
  }

  /**
   * Run `fn(queryable)` with a client bound to this EVENT's tenant.
   * Joins the caller's unit of work when there is one and the tenant matches.
   */
  async function withEventTenant(ev, fn) {
    const tenantId = ev && ev.tenant_id;
    if (!tenantId) {
      const e = new Error('event persistence: event.tenant_id is required');
      e.code = 'EVENT_TENANT_REQUIRED';
      throw e;
    }

    if (hasTenantContext()) {
      const active = getTenantId();
      if (String(active).toLowerCase() === String(tenantId).toLowerCase()) {
        // Same tenant: join the open transaction so the event and the state
        // change it describes share a fate.
        return fn(getTenantClient('eventPersistence'));
      }
      // A different tenant's unit of work is open. Writing this event into that
      // transaction would put one tenant's audit row inside another tenant's
      // work. runWithTenantTransaction refuses this (TENANT_CONTEXT_MISMATCH)
      // rather than silently choosing one — which is what we want to happen.
    }

    return runWithTenantTransaction(pool, tenantId, (client) => fn(client));
  }

  return {
    async insertAuditEvent(ev) {
      await withEventTenant(ev, (client) => client.query(AUDIT_SQL, [
        ev.event_id, ev.event_type, ev.aggregate_type, ev.aggregate_id,
        ev.tenant_id, ev.property_id, ev.actor_id, ev.request_id,
        ev.payload, ev.occurred_at
      ]));
    },

    async insertDomainEvent(ev) {
      return withEventTenant(ev, (client) => domainEventWriter(client)(ev));
    }
  };
}

module.exports = { buildTenantBoundEventWriters, AUDIT_SQL };
