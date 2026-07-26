'use strict';

/**
 * Phase 63 P0-1 — monotonic event_store writer.
 *
 * PROBLEM THIS FIXES
 * ──────────────────
 * `0014_aggregate_snapshots.sql` creates
 *
 *     CREATE UNIQUE INDEX ux_event_store_version
 *       ON event_store(tenant_id, aggregate_type, aggregate_id, event_version);
 *
 * but the domain-event writer used to insert a hard-coded `event_version = 1`
 * for every event. The FIRST domain event of an aggregate therefore persisted
 * and every SUBSEQUENT one failed with 23505. `commandBus.dispatch` catches the
 * publish error, logs it, and still returns `ok:true`, so the loss was silent.
 *
 * Concretely: for one reservation the chain
 *   reservation.created -> reservation.checked_in -> folio.posted ->
 *   payment.allocated  -> reservation.checked_out
 * only ever wrote the FIRST event to the canonical domain-event log.
 *
 * FIX
 * ───
 * Compute the next per-aggregate version inside the INSERT itself:
 *
 *     event_version = COALESCE(MAX(event_version) for that aggregate, 0) + 1
 *
 * Two concurrent writers can still pick the same next version; the unique index
 * rejects the loser with 23505 and we retry. That is textbook optimistic
 * concurrency and is exactly what the index was created for.
 *
 * The subquery is tenant-scoped explicitly AND runs under RLS FORCE, so it can
 * never observe another tenant's stream.
 */

const PG_UNIQUE_VIOLATION = '23505';
const DEFAULT_MAX_ATTEMPTS = 5;

// NOTE ON THE SQL SHAPE
// ─────────────────────
//  * INSERT ... SELECT does not infer parameter types from the target columns
//    (unlike INSERT ... VALUES), and the same parameters are reused inside the
//    version subquery. Every parameter is therefore cast explicitly, otherwise
//    PostgreSQL raises 42P08 "inconsistent types deduced for parameter".
//  * `ON CONFLICT (tenant_id, aggregate_type, aggregate_id, event_version) DO
//    NOTHING` — inferred from the ux_event_store_version UNIQUE INDEX, which is
//    an index rather than a named table constraint, so ON CONSTRAINT is not
//    usable here — makes the version race NON-fatal: the loser simply inserts zero rows instead of
//    aborting the surrounding transaction. That is what makes the retry loop
//    safe when the caller has already opened a transaction (a plain 23505
//    would poison it and every later statement would fail with 25P02).
//    A duplicate PRIMARY KEY (the same event_id replayed) is deliberately NOT
//    covered by the conflict target, so it still raises — a replayed event is
//    a real fault, not contention.
const INSERT_SQL = `
  INSERT INTO event_store
    (id, tenant_id, property_id, aggregate_type, aggregate_id,
     event_type, event_version, payload_json, actor_id, request_id, occurred_at)
  SELECT
    $1::uuid, $2::uuid, $3::uuid, $4::varchar(80), $5::varchar(64), $6::varchar(120),
    COALESCE((SELECT MAX(es.event_version)
                FROM event_store es
               WHERE es.tenant_id      = $2::uuid
                 AND es.aggregate_type = $4::varchar(80)
                 AND es.aggregate_id   = $5::varchar(64)), 0) + 1,
    $7::jsonb, $8::uuid, $9::varchar(64), $10::timestamptz
  ON CONFLICT (tenant_id, aggregate_type, aggregate_id, event_version) DO NOTHING
  RETURNING event_version`;

/**
 * Build an `insertDomainEvent(ev)` function bound to a query-capable handle.
 *
 * @param {{ query: (text: string, params: any[]) => Promise<{rows: any[]}> }} queryable
 *        A pg Pool / Client / instrumented pool wrapper.
 * @param {{ maxAttempts?: number }} [opts]
 * @returns {(ev: object) => Promise<number>} resolves with the persisted version
 */
function buildDomainEventWriter(queryable, opts = {}) {
  if (!queryable || typeof queryable.query !== 'function') {
    throw new Error('buildDomainEventWriter: a queryable with .query() is required');
  }
  const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0
    ? opts.maxAttempts
    : DEFAULT_MAX_ATTEMPTS;

  return async function insertDomainEvent(ev) {
    if (!ev || !ev.event_id) throw new Error('insertDomainEvent: event_id is required');

    const payload = (ev.payload === undefined || ev.payload === null) ? {} : ev.payload;
    const params = [
      ev.event_id, ev.tenant_id, ev.property_id || null,
      ev.aggregate_type, ev.aggregate_id, ev.event_type,
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      ev.actor_id || null, ev.request_id, ev.occurred_at
    ];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // A non-version error (duplicate PK, FK violation, RLS rejection, …) is
      // NOT caught here: it propagates so eventBus.persistToAudit rethrows and
      // the failure becomes visible instead of being silently dropped.
      const res = await queryable.query(INSERT_SQL, params);
      if (res && res.rows && res.rows.length > 0) return res.rows[0].event_version;
      // Zero rows => another writer took this version. Recompute and retry.
    }

    const e = new Error('event_store_version_contention: exhausted ' + maxAttempts + ' attempts');
    e.code = PG_UNIQUE_VIOLATION;
    e.constraint = 'ux_event_store_version';
    throw e;
  };
}

module.exports = { buildDomainEventWriter, INSERT_SQL, DEFAULT_MAX_ATTEMPTS };
