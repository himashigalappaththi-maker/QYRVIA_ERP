-- QYRVIA Phase 66A (B2M) — durable reservation-action queue retry, capped
-- backoff and dead-letter handling.
--
-- DISCLOSED DESIGN DEVIATION: NO RETRY_WAIT STATUS VALUE
-- ────────────────────────────────────────────────────────
-- worker_resolvers.pending_channel_tenants(integer) is a SECURITY DEFINER
-- function owned by qyrvia_auth_resolver, created only by
-- scripts/db/phase66a_worker_resolvers_bootstrap.sql, which must be run by a
-- PostgreSQL SUPERUSER (that script's own header: "Ownership cannot be
-- assigned by the migration runner — PostgreSQL refuses with 42501 'must be
-- able to SET ROLE' because the runtime role is deliberately not a member of
-- that role"). Its body hardcodes `WHERE q.status = 'PENDING' AND ...`.
-- Re-running that bootstrap to teach the resolver a new status value is a
-- superuser operation this phase's own absolute safety rules forbid
-- ("do not execute a bootstrap", "do not connect as postgres or another
-- superuser"). A literal RETRY_WAIT status the resolver cannot see would
-- make affected tenants' retry work permanently undiscoverable — silently
-- worse than today, not better.
--
-- The existing schema was already built for exactly this case: next_retry_at,
-- next_run_at, retry_count and max_retries are already part of BOTH the
-- resolver's WHERE clause and dbStores.js's dequeue() WHERE clause (Phase 24
-- B6 / Phase 53). A scheduled retry therefore stays status='PENDING' with
-- next_retry_at set to a future timestamp — already correctly excluded from
-- discovery/claim until due, by code that exists today and needs no change.
-- This is not a workaround; it is what the pre-existing dormant
-- leaseQueue.js (Phase 24 B6, unused since Phase 66A-B2J's repair, still
-- present and untouched) already modeled: markFailedRetry() there also
-- returns a job to STATUS.PENDING with next_retry_at set, never introducing
-- a distinct in-between status. This migration follows that same repository
-- precedent.
--
-- WHAT THIS MIGRATION ACTUALLY DOES
-- ──────────────────────────────────
-- 1. Adds DEAD_LETTER as an explicit terminal status (exhausted retries or a
--    non-retryable failure never revisits PENDING again).
-- 2. Retains FAILED in the CHECK constraint for historical/backward
--    compatibility (per this phase's own instruction: do not drop or
--    rewrite historical rows). No row in any environment this migration has
--    been verified against currently uses FAILED — read-only preflight
--    confirmed the table is entirely empty (zero rows of any status) before
--    this migration was written.
-- 3. Widens the active-state dedupe key from PENDING-only to
--    PENDING+PROCESSING, closing a pre-existing gap: the original
--    uq_csqs_pending_channel index (0084) only prevented a duplicate PENDING
--    row — nothing prevented a second PENDING row being enqueued for the
--    same (tenant, reservation, action, channel) while an existing row for
--    that exact key was already PROCESSING. Because a scheduled retry stays
--    PENDING (per the design note above), this widened key is also what
--    prevents two active attempts (a live PROCESSING attempt and a
--    would-be-retry PENDING row) for the same logical job from coexisting.
-- 4. Adds no new column. retry_count, max_retries, next_retry_at and
--    next_run_at (Phase 24 B6 / Phase 53) already fully support the backoff
--    and retry-limit semantics this phase needs.
-- 5. Grants nothing new. qyrvia_auth_resolver's exact existing column-level
--    SELECT grant set (migration 0085) already covers every column the
--    resolver reads; DEAD_LETTER rows are simply excluded by the resolver's
--    own unchanged `status = 'PENDING'` predicate, exactly like COMPLETED
--    and FAILED rows already are today.
--
-- ACTIVE-STATE DUPLICATE PREFLIGHT
-- ─────────────────────────────────
-- A read-only preflight (outside this file, against the live target this
-- migration was authored against) found zero rows of any status in
-- channel_sync_queue_store, and therefore zero duplicate groups under the
-- widened (tenant_id, reservation_id, action, COALESCE(channel,'')) key
-- across PENDING+PROCESSING. The DO block immediately below re-runs that
-- exact check at migration time, in the target environment actually being
-- migrated, and aborts the whole transaction (RAISE EXCEPTION) if any
-- duplicate group is found, rather than trusting the preflight's own
-- earlier, separate observation.
--
-- TRANSACTION OWNERSHIP
-- ──────────────────────
-- This file contains no BEGIN, COMMIT or ROLLBACK, matching every other
-- migration's stated convention in this track (e.g. 0085's own header).
-- Transaction ownership belongs to server/src/db/migrate.js, which wraps
-- this file's statements and the schema_migrations tracking insert in one
-- atomic transaction. Every RAISE EXCEPTION below propagates as a normal
-- exception, triggering the runner's own ROLLBACK.
--
-- NO ROLE, RLS OR RESOLVER CHANGE
-- ─────────────────────────────────
-- This migration touches no role, no RLS policy, no FORCE RLS setting, and
-- no grant. worker_resolvers.pending_channel_tenants is not modified in any
-- way — its body, ownership, SECURITY DEFINER attribute and search_path all
-- remain byte-for-byte as installed by the bootstrap script.

-- ── 1. Active-state duplicate preflight — abort if any duplicate exists ────
DO $$
DECLARE
  v_dup_groups int;
BEGIN
  SELECT count(*) INTO v_dup_groups FROM (
    SELECT tenant_id, reservation_id, action, COALESCE(channel, '')
      FROM channel_sync_queue_store
     WHERE status IN ('PENDING', 'PROCESSING')
     GROUP BY tenant_id, reservation_id, action, COALESCE(channel, '')
    HAVING count(*) > 1
  ) dup;

  IF v_dup_groups > 0 THEN
    RAISE EXCEPTION
      'phase66a_b2m refuses: % duplicate active-state (PENDING/PROCESSING) '
      'group(s) exist for the widened dedupe key (tenant_id, reservation_id, '
      'action, channel). Resolve the duplicates before applying this '
      'migration; no row was rewritten or dropped by this check.',
      v_dup_groups;
  END IF;
END;
$$;

-- ── 2. Widen the status CHECK to add DEAD_LETTER; retain FAILED ────────────
ALTER TABLE channel_sync_queue_store
  DROP CONSTRAINT channel_sync_queue_store_status_check;

ALTER TABLE channel_sync_queue_store
  ADD CONSTRAINT channel_sync_queue_store_status_check
  CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD_LETTER'));

-- ── 3. Widen the active-state dedupe index to PENDING + PROCESSING ─────────
DROP INDEX uq_csqs_pending_channel;

CREATE UNIQUE INDEX uq_csqs_active_channel
  ON channel_sync_queue_store (tenant_id, reservation_id, action, COALESCE(channel, ''))
  WHERE status IN ('PENDING', 'PROCESSING');

-- ── 4. Non-negativity guards on the two retry-budget counters ──────────────
-- Neither column has ever had a bound before this migration (0046 added
-- retry_count, 0064 added max_retries, both plain NOT NULL DEFAULT). A
-- read-only preflight against the target this migration was authored
-- against found zero existing rows of any kind, so there is no historical
-- value to violate either check.
ALTER TABLE channel_sync_queue_store
  ADD CONSTRAINT channel_sync_queue_store_retry_count_nonneg CHECK (retry_count >= 0);

ALTER TABLE channel_sync_queue_store
  ADD CONSTRAINT channel_sync_queue_store_max_retries_nonneg CHECK (max_retries >= 0);

-- ── 5. Postconditions — any violation rolls the whole transaction back ─────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
   WHERE c.relname = 'channel_sync_queue_store'
     AND con.conname = 'channel_sync_queue_store_status_check'
     AND pg_get_constraintdef(con.oid) LIKE '%DEAD_LETTER%'
     AND pg_get_constraintdef(con.oid) LIKE '%FAILED%'
     AND pg_get_constraintdef(con.oid) LIKE '%PENDING%'
     AND pg_get_constraintdef(con.oid) LIKE '%PROCESSING%'
     AND pg_get_constraintdef(con.oid) LIKE '%COMPLETED%'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2m postcondition failed: status CHECK constraint does not '
      'contain the expected exact status set.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'channel_sync_queue_store' AND indexname = 'uq_csqs_pending_channel'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2m postcondition failed: old uq_csqs_pending_channel index '
      'still present.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'channel_sync_queue_store' AND indexname = 'uq_csqs_active_channel'
       AND indexdef LIKE '%PENDING%' AND indexdef LIKE '%PROCESSING%'
       AND indexdef NOT LIKE '%DEAD_LETTER%' AND indexdef NOT LIKE '%COMPLETED%'
       AND indexdef NOT LIKE '%FAILED%'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2m postcondition failed: uq_csqs_active_channel is missing '
      'or its predicate is not exactly PENDING/PROCESSING.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'channel_sync_queue_store'
       AND con.conname = 'channel_sync_queue_store_retry_count_nonneg'
       AND pg_get_constraintdef(con.oid) LIKE '%retry_count >= 0%'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2m postcondition failed: retry_count non-negativity check '
      'is missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'channel_sync_queue_store'
       AND con.conname = 'channel_sync_queue_store_max_retries_nonneg'
       AND pg_get_constraintdef(con.oid) LIKE '%max_retries >= 0%'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2m postcondition failed: max_retries non-negativity check '
      'is missing.';
  END IF;

  IF NOT (
    SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'channel_sync_queue_store'
  ) OR NOT (
    SELECT c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'channel_sync_queue_store'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2m postcondition failed: RLS or FORCE RLS is no longer '
      'enabled on public.channel_sync_queue_store.';
  END IF;

  IF (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'channel_sync_queue_store'
  ) <> 'qyrvia_test' THEN
    RAISE EXCEPTION
      'phase66a_b2m postcondition failed: table owner of '
      'channel_sync_queue_store changed.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'qyrvia_auth_resolver'
       AND (rolcanlogin OR rolsuper OR NOT rolbypassrls)
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2m postcondition failed: qyrvia_auth_resolver role '
      'attributes changed during this migration.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
   WHERE n.nspname = 'worker_resolvers' AND p.proname = 'pending_channel_tenants'
     AND p.prosecdef = true AND r.rolname = 'qyrvia_auth_resolver'
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2m postcondition failed: '
      'worker_resolvers.pending_channel_tenants is missing, not SECURITY '
      'DEFINER, or no longer owned by qyrvia_auth_resolver.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges
     WHERE grantee = 'qyrvia_auth_resolver' AND table_schema = 'public'
       AND table_name = 'channel_sync_queue_store' AND privilege_type = 'SELECT'
       AND column_name NOT IN (
         'max_retries', 'next_retry_at', 'next_run_at', 'retry_count',
         'status', 'tenant_id'
       )
  ) THEN
    RAISE EXCEPTION
      'phase66a_b2m postcondition failed: qyrvia_auth_resolver gained an '
      'unexpected column-level SELECT grant.';
  END IF;
END;
$$;
