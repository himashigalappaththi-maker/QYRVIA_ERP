-- QYRVIA Phase 66A (B2N-B) — purpose-built durable ARI outbox.
--
-- WHY A DEDICATED TABLE
-- ─────────────────────
-- B2N discovery proved channel_sync_queue_store cannot represent ARI events:
-- its action CHECK is hard-limited to the five reservation actions, its
-- reservation_id is NOT NULL and semantically a reservation identifier that
-- three other tables also assume is reservation-shaped, and
-- worker/realProcessor.js's own whitelist would dead-letter any ARI action on
-- first sight. This table models ARI identities DIRECTLY: (tenant, property,
-- event type, room type, rate plan where applicable, effective period,
-- source version). It deliberately has NO reservation_id column and never
-- will.
--
-- WHAT THIS PHASE DOES AND DOES NOT DO
-- ────────────────────────────────────
-- B2N-B creates the schema and persistence contract only. No authoritative
-- ARI mutation enqueues into this table yet (that atomic integration is
-- Phase 66A-B2N-C), no dispatcher claims from it in production, and no
-- provider transport exists for it. The schema is designed so a B2N-C
-- enqueue can share the exact same tenant-bound transaction as the ARI
-- mutation it describes (see src/ari/outbox/tenantAriOutbox.js).
--
-- SAME-TENANT PROPERTY OWNERSHIP (B2N-B pre-application correction #1)
-- ────────────────────────────────────────────────────────────────────
-- A property_id-only foreign key proves the property EXISTS, not that it
-- belongs to the row's own tenant_id — a tenant-A outbox row could reference
-- a tenant-B property and still satisfy such a key while remaining visible
-- as a tenant-A row under RLS. The invariant is therefore database-enforced
-- with a COMPOSITE foreign key:
--
--     FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id)
--
-- Source inspection of the committed schema (0001_init.sql and every later
-- ALTER TABLE properties through 0086) shows properties carries ONLY
-- PRIMARY KEY (id), UNIQUE (tenant_id, code) and non-unique
-- idx_properties_tenant — no unique contract covers (tenant_id, id) in any
-- order, and PostgreSQL requires the referenced columns of a foreign key to
-- be covered by a non-deferrable unique or primary-key constraint. Adding
-- UNIQUE (tenant_id, id) is therefore REQUIRED (no usable reference target
-- exists) and provably SAFE: id alone is already the primary key, so every
-- existing and future row is unique on id and hence trivially unique on
-- (tenant_id, id) — the new constraint can never reject a row the primary
-- key would not already reject. Purely additive; no row is rewritten.
--
-- RETRY MODEL (mirrors the proven B2M reservation-queue model exactly)
-- ────────────────────────────────────────────────────────────────────
-- No RETRY_WAIT status exists. A scheduled retry stays status='PENDING' with
-- next_retry_at set in the future; the claim predicate (store-side) excludes
-- it until due and excludes exhausted rows via retry_count < max_retries.
-- DEAD_LETTER is the explicit terminal failure state. FAILED is deliberately
-- NOT carried over from the reservation queue: this is a brand-new table
-- with zero history, so the historical-compat value has no rows to describe.
--
-- LEASE LIFECYCLE (B2N-B pre-application correction #2)
-- ─────────────────────────────────────────────────────
-- A claim sets status='PROCESSING' plus lease_until/lease_owner. A worker
-- that crashes after claiming would otherwise leave the row PROCESSING
-- forever; the store's requeueExpiredLeases() therefore returns rows whose
-- lease_until has passed to PENDING (lease cleared, retry_count and
-- attempts preserved — a crashed worker never reported a finished attempt),
-- after which the normal claim path picks them up when due.
-- idx_aob_lease_expiry below is the smallest index supporting that recovery
-- predicate: equality on (tenant_id via RLS, status='PROCESSING') then a
-- range scan on lease_until — hence the column order
-- (tenant_id, status, lease_until). Recovery only flips the status of the
-- SAME row (no insert), so it can never create a duplicate row under
-- uq_aob_logical_event.
--
-- GLOBAL LOGICAL-EVENT IDEMPOTENCY (B2N-B final pre-application correction
-- #1; documented explicitly for this new, empty table — there are no
-- pre-existing rows to preflight, and a duplicate preflight over an empty
-- CREATEd table is definitionally satisfied):
-- the same logical event identity (tenant_id, property_id, dedupe_key)
-- exists AT MOST ONCE across EVERY status — not merely once among active
-- rows. An active-only partial uniqueness would let the exact same logical
-- source mutation (same dedupe_key, same source_version) be inserted again
-- after the original row reached COMPLETED or DEAD_LETTER; that is not a
-- durable idempotency contract. uq_aob_logical_event is therefore a full
-- table-level UNIQUE constraint with no status predicate. A later
-- legitimate source version remains insertable because its canonical
-- dedupe_key embeds a different source_version. A future manual replay of a
-- DEAD_LETTER event must be an explicit, separately-reviewed
-- state-transition operation — never an implicit duplicate INSERT — and is
-- deliberately NOT implemented in this phase. dedupe_key is the
-- collision-safe versioned canonical encoding computed by
-- src/ari/outbox/ariOutboxStore.js buildAriDedupeKey():
-- 'aob:v1:' + SHA-256 (lowercase hex) of the JSON.stringify of the ORDERED
-- tuple [eventType, resourceKind, roomTypeId, ratePlanId-or-null,
-- effectiveFrom, effectiveTo, sourceVersion]. Component boundaries are JSON
-- array elements, so identifiers containing any delimiter character can
-- never collide; never an unordered-object serialization, never a random
-- UUID, never payload-derived.
--
-- RESOURCE VOCABULARY
-- ───────────────────
-- RATE and INVENTORY align with the canonical RESOURCE enum
-- (src/channel-manager/core/canonical/types.js). AVAILABILITY is new here:
-- the canonical enum does not yet carry it, and this migration does NOT
-- modify that module — the outbox owns its own vocabulary
-- (src/ari/outbox/ariOutboxStore.js) so no channel-manager coupling exists.
--
-- TENANT ISOLATION
-- ────────────────
-- ENABLE + FORCE ROW LEVEL SECURITY with the app.tenant_id policy, stated
-- EXPLICITLY for both visibility (USING) and writes (WITH CHECK). Every
-- production store operation runs through the tenant-bound unit of work
-- (src/db/tenantUnitOfWork.js) — there is no bare-pool path. No grant to
-- any resolver role is made here: tenant-scoped claim operations are
-- complete without cross-tenant discovery. IF a future dispatcher needs
-- cross-tenant discovery (like worker_resolvers.pending_channel_tenants for
-- the reservation queue), that resolver function requires its own
-- separately-approved bootstrap — deliberately NOT created in this phase.
--
-- No BEGIN/COMMIT/ROLLBACK here: src/db/migrate.js owns the transaction.
-- Forward-only, per repository convention (no down migrations).
-- Beyond the new ari_outbox_store objects, the ONLY touch to an existing
-- object is the additive UNIQUE (tenant_id, id) on properties justified
-- above: no other table, index, policy, role, grant, ownership, or
-- bootstrap function is altered, and migrations 0001-0086 are not modified.

-- Composite reference target for same-tenant property ownership (required +
-- safe per the header analysis). Must exist before the FK below.
ALTER TABLE properties
  ADD CONSTRAINT uq_properties_tenant_property UNIQUE (tenant_id, id);

CREATE TABLE ari_outbox_store (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID         NOT NULL REFERENCES tenants(id),
  property_id      UUID         NOT NULL,
  event_type       VARCHAR(40)  NOT NULL
                     CONSTRAINT ari_outbox_store_event_type_check
                     CHECK (event_type IN ('AVAILABILITY_CHANGED','RATE_CHANGED','INVENTORY_CHANGED')),
  resource_kind    VARCHAR(20)  NOT NULL
                     CONSTRAINT ari_outbox_store_resource_kind_check
                     CHECK (resource_kind IN ('AVAILABILITY','RATE','INVENTORY')),
  room_type_id     VARCHAR(64)  NOT NULL
                     CONSTRAINT ari_outbox_store_room_type_nonempty
                     CHECK (length(room_type_id) > 0),
  rate_plan_id     VARCHAR(64),
  effective_from   DATE         NOT NULL,
  effective_to     DATE         NOT NULL,
  source_version   INTEGER      NOT NULL
                     CONSTRAINT ari_outbox_store_source_version_positive
                     CHECK (source_version >= 1),
  dedupe_key       VARCHAR(400) NOT NULL
                     CONSTRAINT ari_outbox_store_dedupe_key_nonempty
                     CHECK (length(dedupe_key) > 0),
  payload_json     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  status           VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                     CONSTRAINT ari_outbox_store_status_check
                     CHECK (status IN ('PENDING','PROCESSING','COMPLETED','DEAD_LETTER')),
  attempts         INTEGER      NOT NULL DEFAULT 0
                     CONSTRAINT ari_outbox_store_attempts_nonneg
                     CHECK (attempts >= 0),
  retry_count      INTEGER      NOT NULL DEFAULT 0
                     CONSTRAINT ari_outbox_store_retry_count_nonneg
                     CHECK (retry_count >= 0),
  max_retries      INTEGER      NOT NULL DEFAULT 4
                     CONSTRAINT ari_outbox_store_max_retries_nonneg
                     CHECK (max_retries >= 0),
  next_retry_at    TIMESTAMPTZ,
  lease_until      TIMESTAMPTZ,
  lease_owner      VARCHAR(120),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  -- Same-tenant property ownership, database-enforced (see header): the
  -- (tenant_id, property_id) pair must exist as a (tenant_id, id) pair on
  -- properties — a property belonging to a different tenant cannot satisfy
  -- this key. This composite FK is the property relationship; there is
  -- deliberately NO property_id-only foreign key.
  CONSTRAINT ari_outbox_store_property_same_tenant_fk
    FOREIGN KEY (tenant_id, property_id)
    REFERENCES properties (tenant_id, id),
  -- Half-open effective range [from, to), same convention as ari_rate_rule /
  -- ari_restriction_rule (0049): a single-day event is [d, d+1).
  CONSTRAINT ari_outbox_store_effective_range_valid
    CHECK (effective_to > effective_from),
  -- Event type and resource kind must agree — one cannot describe an
  -- availability change as a rate resource.
  CONSTRAINT ari_outbox_store_event_resource_compat
    CHECK (
      (event_type = 'AVAILABILITY_CHANGED' AND resource_kind = 'AVAILABILITY') OR
      (event_type = 'RATE_CHANGED'         AND resource_kind = 'RATE')         OR
      (event_type = 'INVENTORY_CHANGED'    AND resource_kind = 'INVENTORY')
    ),
  -- rate_plan_id belongs to rate events only. It stays nullable even for
  -- RATE_CHANGED (a property-level rate rule change has no single plan);
  -- non-rate events must never carry an irrelevant rate-plan identity.
  CONSTRAINT ari_outbox_store_rate_plan_compat
    CHECK (rate_plan_id IS NULL OR event_type = 'RATE_CHANGED'),
  -- Global logical-event idempotency (see header): one row per logical
  -- event identity across EVERY status. Not a partial/active-only index —
  -- COMPLETED and DEAD_LETTER history also deduplicates an identical
  -- re-enqueue; a later source version has a different dedupe_key.
  CONSTRAINT uq_aob_logical_event
    UNIQUE (tenant_id, property_id, dedupe_key)
);

-- Claim support: the tenant-scoped claim reads PENDING rows in created_at
-- order (RLS supplies the tenant predicate; tenant_id leads the index so the
-- policy's implicit filter is SARGable).
CREATE INDEX idx_aob_claim
  ON ari_outbox_store (tenant_id, status, created_at);

-- Retry due-ness support for the future dispatcher's due-time predicate.
CREATE INDEX idx_aob_retry_due
  ON ari_outbox_store (tenant_id, status, next_retry_at);

-- Expired-lease recovery support (correction #2): equality on tenant
-- (via RLS) + status='PROCESSING', then a range scan on lease_until — the
-- exact predicate of requeueExpiredLeases(). Smallest index that serves it.
CREATE INDEX idx_aob_lease_expiry
  ON ari_outbox_store (tenant_id, status, lease_until);

ALTER TABLE ari_outbox_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE ari_outbox_store FORCE  ROW LEVEL SECURITY;
-- Explicit USING (visibility) AND WITH CHECK (writes): a session bound to
-- tenant A can neither see nor create/modify rows carrying another tenant_id.
CREATE POLICY ari_outbox_store_by_app ON ari_outbox_store
  USING      (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

-- Postconditions (0086 precedent): fail the whole migration transaction if
-- any invariant this migration promises did not actually take effect.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'ari_outbox_store'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nb postcondition failed: ari_outbox_store missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'properties'
       AND con.conname = 'uq_properties_tenant_property'
       AND con.contype = 'u'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nb postcondition failed: uq_properties_tenant_property missing on properties';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'ari_outbox_store'
       AND con.conname = 'ari_outbox_store_property_same_tenant_fk'
       AND con.contype = 'f'
       AND pg_get_constraintdef(con.oid) LIKE '%(tenant_id, property_id)%'
       AND pg_get_constraintdef(con.oid) LIKE '%properties(tenant_id, id)%'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nb postcondition failed: composite same-tenant property FK missing or wrong shape';
  END IF;

  IF NOT (
    SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'ari_outbox_store'
  ) OR NOT (
    SELECT c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'ari_outbox_store'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nb postcondition failed: RLS or FORCE RLS not enabled on ari_outbox_store';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'ari_outbox_store'
       AND policyname = 'ari_outbox_store_by_app'
       AND qual IS NOT NULL
       AND with_check IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nb postcondition failed: ari_outbox_store_by_app policy missing its USING or WITH CHECK expression';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ari_outbox_store'
       AND column_name = 'reservation_id'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nb postcondition failed: ari_outbox_store must never carry reservation_id';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'ari_outbox_store'
       AND con.conname = 'uq_aob_logical_event'
       AND con.contype = 'u'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nb postcondition failed: global uq_aob_logical_event constraint missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'ari_outbox_store'
       AND indexdef LIKE 'CREATE UNIQUE%'
       AND indexdef LIKE '%WHERE%'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nb postcondition failed: a partial (status-limited) unique index exists — idempotency must be the global constraint';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'ari_outbox_store' AND indexname = 'idx_aob_lease_expiry'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nb postcondition failed: idx_aob_lease_expiry missing';
  END IF;

  -- This migration must not have touched the reservation queue or any
  -- resolver-role posture: identical assertions to 0086's own postconditions.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname = 'channel_sync_queue_store'
       AND con.conname = 'channel_sync_queue_store_status_check'
       AND pg_get_constraintdef(con.oid) LIKE '%DEAD_LETTER%'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nb postcondition failed: channel_sync_queue_store status contract changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'qyrvia_auth_resolver'
       AND (rolcanlogin OR rolsuper OR NOT rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nb postcondition failed: qyrvia_auth_resolver role attributes changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee = 'qyrvia_auth_resolver'
       AND table_schema = 'public' AND table_name = 'ari_outbox_store'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nb postcondition failed: ari_outbox_store must not be granted to the resolver role in this phase';
  END IF;
END;
$$;
