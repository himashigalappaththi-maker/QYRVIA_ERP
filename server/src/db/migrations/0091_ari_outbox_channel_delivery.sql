-- QYRVIA Phase 68A — durable per-channel ARI delivery ledger.
--
-- WHY A DEDICATED TABLE
-- ─────────────────────
-- Instruction 031's audit found: ariOutboxWorker dispatches ONE row per
-- (tenant, ARI event) with no channel field in its envelope at all (Section
-- 8) — channel fan-out is entirely the injected dispatcher's job. A future
-- multi-channel dispatcher (Booking.com now, more providers later) can
-- therefore succeed on channel A and fail on channel B for the SAME ari
-- outbox row; the worker's at-least-once delivery model means that row WILL
-- be redelivered (lease expiry, or a retryable dispatch() rejection). Without
-- a durable per-channel record, a redelivery would resend to channel A too —
-- a P0 duplicate-delivery defect the instruction 031 audit named explicitly
-- as BLOCKED and instruction 032 requires closed BEFORE any dispatcher may
-- ever be considered LIVE. An in-memory or log-only ledger does not survive
-- a worker crash/restart between the two channels' attempts, so it cannot
-- close this gap — only a durable table can.
--
-- WHAT THIS PHASE DOES AND DOES NOT DO
-- ────────────────────────────────────
-- This migration creates the ledger schema ONLY. No dispatcher exists yet
-- that is reachable in production (ARI_OUTBOX_WORKER_ENABLED,
-- ARI_OUTBOX_DISPATCH_ENABLED and the new ARI_BOOKING_COM_LIVE gate all
-- default false — see server/src/ari/dispatch/ariChannelDispatcher.js), no
-- row is ever written to this table by this migration, and this migration
-- is NOT executed as part of this instruction (static contract review only,
-- per server/test/phase68_migration_0091_ari_outbox_channel_delivery.test.js).
--
-- SAME-TENANT OWNERSHIP, DOUBLY ENFORCED (mirrors 0087's composite-FK
-- reasoning for ari_outbox_store -> properties, applied twice here)
-- ────────────────────────────────────────────────────────────────────────
-- A bare `ari_outbox_id` FK to ari_outbox_store(id) proves the referenced
-- outbox row EXISTS, not that it belongs to THIS ledger row's own
-- tenant_id — a tenant-A ledger row could reference a tenant-B outbox row
-- and still satisfy such a key while remaining visible as a tenant-A row
-- under RLS. ari_outbox_store currently has no unique target covering
-- (tenant_id, id) (only its own PRIMARY KEY (id)), so — exactly as 0087 did
-- for properties — this migration first adds
--   ALTER TABLE ari_outbox_store ADD CONSTRAINT uq_ari_outbox_store_tenant_id UNIQUE (tenant_id, id);
-- which is provably safe: id alone is already the primary key, so every
-- existing and future row is trivially unique on (tenant_id, id) too — the
-- new constraint can never reject a row the primary key would not already
-- reject, and no row is rewritten. The ledger's own composite FK
--   FOREIGN KEY (tenant_id, ari_outbox_id) REFERENCES ari_outbox_store (tenant_id, id)
-- then makes cross-tenant reference impossible at the database level. The
-- SAME reasoning is reused (not re-derived) for property_id, referencing
-- 0087's own uq_properties_tenant_property — no second ALTER on properties.
--
-- ONE LEDGER ROW PER (TENANT, OUTBOX EVENT, CHANNEL)
-- ────────────────────────────────────────────────────
-- ari_outbox_store's OWN uq_aob_logical_event constraint already guarantees
-- one row per logical (tenant, property, dedupe_key) identity, and
-- dedupe_key embeds source_version (ariOutboxStore.buildAriDedupeKey) — so a
-- given ari_outbox_id already pins one exact logical event AT one exact
-- source_version, immutable once inserted (the outbox row is never updated
-- to a new source_version; a new version gets a new dedupe_key and hence a
-- new outbox row). The narrowest correct uniqueness for "one durable
-- delivery record per tenant / outbox event / channel" is therefore
--   UNIQUE (tenant_id, ari_outbox_id, channel_code)
-- with no need to separately re-encode dedupe_key/source_version into the
-- uniqueness — dedupe_key and source_version are still stored as columns
-- (denormalized from the outbox row at ledger-creation time) purely so a
-- ledger row is self-describing for audit/debugging without a join, never as
-- part of the identity key.
--
-- CANONICAL CHANNEL CODES ONLY
-- ─────────────────────────────
-- channel_code is constrained to the exact ROUTABLE_CHANNELS set
-- (src/channel-manager/services/channelEventRouter.js) — the same 8 codes
-- BOOKING_COM/AGODA/EXPEDIA/AIRBNB/MAKEMYTRIP/GOOGLE/TRIPADVISOR/
-- QYRVIA_CONNECT. QTCN is deliberately EXCLUDED from the CHECK exactly as it
-- is excluded from ROUTABLE_CHANNELS: it is a legacy read-alias, never a
-- value any code path should ever WRITE (canonicalChannelCode() normalizes
-- it away before any write path is reached).
--
-- STATUS MODEL — mirrors the proven B2M/B2N retry model, not reinvented
-- ────────────────────────────────────────────────────────────────────
-- PENDING -> PROCESSING -> (COMPLETED | RETRY | DEAD_LETTER). RETRY is a
-- terminal-for-this-attempt, non-terminal-for-the-row state: unlike
-- ari_outbox_store (which schedules its own next_retry_at and stays
-- PENDING), retry TIMING for a channel delivery is entirely owned by the
-- OUTER ari_outbox_store row's own backoff (ariOutboxWorker.computeRetryDelayMs)
-- — this ledger does not schedule anything itself, it only remembers "this
-- channel still needs another attempt when the outbox row is next claimed".
-- attempt_count increments once per completed processing attempt (mirrors
-- ari_outbox_store's own attempts/retry_count discipline: a crash before
-- reporting is not a counted attempt).
--
-- TENANT ISOLATION
-- ────────────────
-- ENABLE + FORCE ROW LEVEL SECURITY with the CURRENT canonical sargable
-- policy form used by every migration after 0051
-- (`tenant_id = app_current_tenant()`, explicit USING AND WITH CHECK) — NOT
-- the older `current_setting('app.tenant_id', true)` form 0087 used before
-- 0051's SARGable rewrite existed for new tables to adopt directly. Every
-- production access must go through a tenant-bound unit of work
-- (src/db/tenantUnitOfWork.js) via the new repository
-- src/ari/dispatch/ariChannelDeliveryLedger.js — there is no bare-pool path.
-- No PUBLIC grant, no BYPASSRLS, no SECURITY DEFINER anywhere in this
-- migration: no cross-tenant discovery is required for this ledger (unlike
-- worker_resolvers.due_ari_outbox_tenants) because every access is already
-- scoped by an ari_outbox_id the caller obtained from its OWN tenant-bound
-- claim of the outbox row.
--
-- No BEGIN/COMMIT/ROLLBACK here: src/db/migrate.js owns the transaction.
-- Forward-only, per repository convention (no down migrations). This
-- migration is purely additive: it does not alter ari_outbox_store's
-- semantics, columns, constraints, indexes, policy or postconditions beyond
-- the one additive UNIQUE justified above, and it does not touch
-- channel_sync_queue_store, channel_registry, or any Phase 67 (0090) object.

ALTER TABLE ari_outbox_store
  ADD CONSTRAINT uq_ari_outbox_store_tenant_id UNIQUE (tenant_id, id);

CREATE TABLE ari_outbox_channel_delivery (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID         NOT NULL REFERENCES tenants(id),
  property_id      UUID         NOT NULL,
  ari_outbox_id    UUID         NOT NULL,
  channel_code     VARCHAR(20)  NOT NULL
                     CONSTRAINT aocd_channel_code_check
                     CHECK (channel_code IN (
                       'BOOKING_COM','AGODA','EXPEDIA','AIRBNB',
                       'MAKEMYTRIP','GOOGLE','TRIPADVISOR','QYRVIA_CONNECT'
                     )),
  dedupe_key       VARCHAR(400) NOT NULL
                     CONSTRAINT aocd_dedupe_key_nonempty
                     CHECK (length(dedupe_key) > 0),
  source_version   INTEGER      NOT NULL
                     CONSTRAINT aocd_source_version_positive
                     CHECK (source_version >= 1),
  status           VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                     CONSTRAINT aocd_status_check
                     CHECK (status IN ('PENDING','PROCESSING','RETRY','COMPLETED','DEAD_LETTER')),
  attempt_count    INTEGER      NOT NULL DEFAULT 0
                     CONSTRAINT aocd_attempt_count_nonneg
                     CHECK (attempt_count >= 0),
  provider_ack_id  TEXT,
  last_error_code  VARCHAR(120),
  last_error_class VARCHAR(20)
                     CONSTRAINT aocd_last_error_class_check
                     CHECK (last_error_class IS NULL OR last_error_class IN ('RETRYABLE','NON_RETRYABLE')),
  last_attempt_at  TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Same-tenant ownership of the referenced outbox row, database-enforced
  -- (see header). Deliberately NO ari_outbox_id-only foreign key.
  CONSTRAINT aocd_outbox_same_tenant_fk
    FOREIGN KEY (tenant_id, ari_outbox_id)
    REFERENCES ari_outbox_store (tenant_id, id),

  -- Same-tenant ownership of property_id, reusing 0087's existing
  -- uq_properties_tenant_property target (no second ALTER on properties).
  CONSTRAINT aocd_property_same_tenant_fk
    FOREIGN KEY (tenant_id, property_id)
    REFERENCES properties (tenant_id, id),

  -- Narrowest correct identity (see header): one durable delivery record per
  -- tenant / outbox event / canonical channel.
  CONSTRAINT uq_aocd_event_channel
    UNIQUE (tenant_id, ari_outbox_id, channel_code)
);

-- "List deliveries for one ARI outbox event" (repository requirement 7):
-- equality on tenant (RLS) + ari_outbox_id.
CREATE INDEX idx_aocd_by_outbox
  ON ari_outbox_channel_delivery (tenant_id, ari_outbox_id);

-- Claim/scan support, mirroring idx_aob_claim's shape for the same reason:
-- tenant-scoped status lookups in creation order.
CREATE INDEX idx_aocd_claim
  ON ari_outbox_channel_delivery (tenant_id, status, created_at);

ALTER TABLE ari_outbox_channel_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE ari_outbox_channel_delivery FORCE  ROW LEVEL SECURITY;
CREATE POLICY ari_outbox_channel_delivery_by_app ON ari_outbox_channel_delivery
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- Postconditions (0086/0087/0090 precedent): fail the whole migration
-- transaction if any invariant this migration promises did not take effect.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'ari_outbox_store'
       AND con.conname = 'uq_ari_outbox_store_tenant_id'
       AND con.contype = 'u'
  ) THEN
    RAISE EXCEPTION 'phase68a postcondition failed: uq_ari_outbox_store_tenant_id missing on ari_outbox_store';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'ari_outbox_channel_delivery'
  ) THEN
    RAISE EXCEPTION 'phase68a postcondition failed: ari_outbox_channel_delivery missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'ari_outbox_channel_delivery'
       AND con.conname = 'aocd_outbox_same_tenant_fk'
       AND con.contype = 'f'
       AND pg_get_constraintdef(con.oid) LIKE '%(tenant_id, ari_outbox_id)%'
       AND pg_get_constraintdef(con.oid) LIKE '%ari_outbox_store(tenant_id, id)%'
  ) THEN
    RAISE EXCEPTION 'phase68a postcondition failed: composite same-tenant outbox FK missing or wrong shape';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'ari_outbox_channel_delivery'
       AND con.conname = 'aocd_property_same_tenant_fk'
       AND con.contype = 'f'
       AND pg_get_constraintdef(con.oid) LIKE '%(tenant_id, property_id)%'
       AND pg_get_constraintdef(con.oid) LIKE '%properties(tenant_id, id)%'
  ) THEN
    RAISE EXCEPTION 'phase68a postcondition failed: composite same-tenant property FK missing or wrong shape';
  END IF;

  IF NOT (
    SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'ari_outbox_channel_delivery'
  ) OR NOT (
    SELECT c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'ari_outbox_channel_delivery'
  ) THEN
    RAISE EXCEPTION 'phase68a postcondition failed: RLS or FORCE RLS not enabled on ari_outbox_channel_delivery';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'ari_outbox_channel_delivery'
       AND policyname = 'ari_outbox_channel_delivery_by_app'
       AND qual IS NOT NULL
       AND with_check IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'phase68a postcondition failed: ari_outbox_channel_delivery_by_app policy missing its USING or WITH CHECK expression';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'ari_outbox_channel_delivery'
       AND con.conname = 'uq_aocd_event_channel'
       AND con.contype = 'u'
  ) THEN
    RAISE EXCEPTION 'phase68a postcondition failed: uq_aocd_event_channel constraint missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'ari_outbox_channel_delivery'
       AND grantee = 'PUBLIC'
  ) THEN
    RAISE EXCEPTION 'phase68a postcondition failed: ari_outbox_channel_delivery must not be granted to PUBLIC';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'qyrvia_auth_resolver'
       AND (rolcanlogin OR rolsuper OR NOT rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'phase68a postcondition failed: qyrvia_auth_resolver role attributes changed';
  END IF;

  -- This migration must not have touched ari_outbox_store's own posture
  -- beyond the one additive UNIQUE asserted above: same RLS/policy/FK
  -- survival checks 0088 already proved, re-asserted here so a future
  -- accidental edit to THIS migration cannot silently regress them.
  IF NOT (
    SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'ari_outbox_store'
  ) OR NOT (
    SELECT c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'ari_outbox_store'
  ) THEN
    RAISE EXCEPTION 'phase68a postcondition failed: ari_outbox_store RLS/FORCE RLS regressed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'ari_outbox_store' AND con.conname = 'uq_aob_logical_event'
  ) THEN
    RAISE EXCEPTION 'phase68a postcondition failed: ari_outbox_store.uq_aob_logical_event regressed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'channel_sync_queue_store'
       AND column_name = 'ari_outbox_id'
  ) THEN
    RAISE EXCEPTION 'phase68a postcondition failed: channel_sync_queue_store must remain untouched by this migration';
  END IF;
END;
$$;
