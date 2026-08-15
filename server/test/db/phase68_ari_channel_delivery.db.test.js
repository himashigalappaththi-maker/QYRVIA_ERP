'use strict';

/**
 * Phase 68A — LIVE PostgreSQL tests for ari_outbox_channel_delivery
 * (migration 0091). SOURCE ONLY in this instruction — instruction 032
 * explicitly prohibits any PostgreSQL connection or migration execution, so
 * this file is committed but NEVER run here. It follows the exact naming/
 * gating convention every other server/test/db/*.db.test.js file in this
 * repository uses, so it is automatically excluded from every safe
 * (non-DB) test run by the same directory/suffix convention instruction 031
 * and 032 both rely on.
 *
 * Intended coverage once separately authorized against a real qyrvia_test
 * database with migration 0091 applied:
 *
 *   - cross-tenant RLS: a session bound to tenant A can neither SELECT nor
 *     UPDATE a tenant B row in ari_outbox_channel_delivery, even by primary
 *     key, and vice versa (mirrors phase66a_b2nb_ari_outbox.db.test.js's own
 *     cross-tenant proof pattern for ari_outbox_store).
 *   - unique delivery creation: two concurrent ensureDelivery() calls for the
 *     SAME (tenant, ari_outbox_id, channel_code) race to insert and the loser
 *     observes the winner's row via the ON CONFLICT DO NOTHING + follow-up
 *     SELECT path — never two rows, never a constraint-violation escaping to
 *     the caller.
 *   - concurrent claim: two workers racing claim() on the SAME delivery row
 *     — FOR UPDATE SKIP LOCKED must hand the row to exactly one caller; the
 *     other must see null, never a second PROCESSING transition.
 *   - completed-channel redelivery skip: after markCompleted(), a second
 *     ensureDelivery() for the identical (tenant, ari_outbox_id,
 *     channel_code) must return the SAME already-COMPLETED row, and a
 *     subsequent claim() on it must return null — proving the durable P0
 *     double-send guard actually holds under real RLS + real concurrency,
 *     not just the mocked-pool proof in
 *     server/test/phase68_ari_channel_delivery_ledger.test.js.
 *   - transaction behavior: a thrown error inside the SAME tenant-bound unit
 *     of work as an ensureDelivery()/claim() call rolls back that call too
 *     (tenantUnitOfWork.js's existing rollback discipline, exercised against
 *     this specific table for the first time).
 *   - composite FK enforcement: an attempt to insert a delivery row whose
 *     (tenant_id, ari_outbox_id) does NOT match an existing same-tenant
 *     ari_outbox_store row is rejected by aocd_outbox_same_tenant_fk, not
 *     merely by application-level validation.
 *
 * DO NOT RUN. DO NOT connect to PostgreSQL from this file in this
 * instruction. This file exists so the FUTURE, separately authorized live-DB
 * validation pass (instruction 032 Section 28's stated prerequisite before
 * any LIVE gate can be enabled) has a concrete starting point.
 */

const { test } = require('node:test');

test.skip('cross-tenant RLS on ari_outbox_channel_delivery (requires a live qyrvia_test database — not run in this instruction)', () => {
  throw new Error('not implemented in this instruction — source only, per instruction 032 Section 21');
});
