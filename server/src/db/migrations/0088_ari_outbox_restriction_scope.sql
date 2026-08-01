-- QYRVIA Phase 66A (B2N-C2) — ARI outbox support for restriction-rule scope.
--
-- WHY THIS MIGRATION IS UNAVOIDABLE
-- ─────────────────────────────────
-- ari_restriction_rule (migration 0049) has NULLABLE room_type_id and
-- rate_plan_id, because a rule may be scoped property-wide, to a room type,
-- to a rate plan, or to both. Migration 0087's ari_outbox_store cannot store
-- three of those four scopes:
--
--   * room_type_id is NOT NULL with CHECK (length > 0), so a property-wide
--     or rate-plan-only rule is physically unstorable;
--   * ari_outbox_store_rate_plan_compat restricts a non-null rate_plan_id to
--     event_type = 'RATE_CHANGED', but a restriction event is
--     AVAILABILITY_CHANGED, so a rate-plan-scoped restriction cannot carry
--     its own rate plan.
--
-- No identity design can bypass a NOT NULL column or a CHECK constraint, so
-- the outbox must learn about restriction scope. This migration teaches it
-- WITHOUT weakening any guarantee for the five existing (v1) event classes:
-- every relaxation is gated on restriction_rule_id being present.
--
-- IDENTITY: KEY VERSION 2, ADDITIVE
-- ─────────────────────────────────
-- Restriction events use a separate canonical identity
--   aob:v2:<64 lowercase hex sha256>
-- over the ordered tuple
--   [AVAILABILITY_CHANGED, AVAILABILITY, 'RESTRICTION_RULE',
--    restrictionRuleId, level, roomTypeId-or-null, ratePlanId-or-null,
--    channel-or-null, effectiveFrom, effectiveTo, sourceVersion]
-- computed by src/ari/outbox/ariOutboxStore.js buildAriRestrictionDedupeKey().
-- restrictionRuleId is ari_restriction_rule.id — the caller-supplied,
-- IMMUTABLE identifier already in that table's primary key, so no value is
-- invented and no placeholder room type is created.
--
-- aob:v1 is NOT touched: its tuple, arity, prefix and meaning are unchanged
-- and still used by INVENTORY_CHANGED (adjustSold, putInventoryCell,
-- updateInventoryOptimistic), AVAILABILITY_CHANGED (putRoomType) and
-- RATE_CHANGED (putRatePlan). No existing dedupe_key is read, rewritten or
-- re-hashed by this migration.
--
-- SAFETY FOR EXISTING ROWS
-- ────────────────────────
-- Every existing row has a non-null room_type_id and (necessarily) a null
-- restriction_rule_id, so it satisfies every constraint below unchanged.
-- Dropping a NOT NULL and widening a CHECK can only ADMIT rows, never reject
-- ones that already exist, so NO backfill and NO duplicate preflight is
-- required. uq_aob_logical_event is deliberately left exactly as-is: a v2
-- key is simply another value in the same column, so global logical
-- idempotency continues to hold across both key versions.
--
-- No BEGIN/COMMIT/ROLLBACK here: src/db/migrate.js owns the transaction.
-- Forward-only, per repository convention. Touches ONLY ari_outbox_store:
-- no other table, no role, grant, ownership, policy, RLS or FORCE RLS
-- change, no reservation_id, and channel_sync_queue_store is untouched.

-- A. the immutable restriction identity (nullable; no FK — outbox history
--    must survive its source rule's lifetime).
ALTER TABLE ari_outbox_store
  ADD COLUMN restriction_rule_id VARCHAR(80);

-- B. a present restriction id must be meaningful.
ALTER TABLE ari_outbox_store
  ADD CONSTRAINT ari_outbox_store_restriction_rule_id_nonempty
  CHECK (restriction_rule_id IS NULL OR length(restriction_rule_id) > 0);

-- C. + D. room_type_id becomes nullable, but an empty string stays illegal.
ALTER TABLE ari_outbox_store
  ALTER COLUMN room_type_id DROP NOT NULL;
ALTER TABLE ari_outbox_store
  DROP CONSTRAINT ari_outbox_store_room_type_nonempty;
ALTER TABLE ari_outbox_store
  ADD CONSTRAINT ari_outbox_store_room_type_nonempty
  CHECK (room_type_id IS NULL OR length(room_type_id) > 0);

-- E. ONLY a restriction event may omit the room type. Every existing event
--    class keeps its effective NOT NULL guarantee.
ALTER TABLE ari_outbox_store
  ADD CONSTRAINT ari_outbox_store_room_type_required
  CHECK (room_type_id IS NOT NULL OR restriction_rule_id IS NOT NULL);

-- F. rate_plan_id is widened for restriction events ONLY. A non-restriction
--    AVAILABILITY_CHANGED or INVENTORY_CHANGED event still rejects it.
ALTER TABLE ari_outbox_store
  DROP CONSTRAINT ari_outbox_store_rate_plan_compat;
ALTER TABLE ari_outbox_store
  ADD CONSTRAINT ari_outbox_store_rate_plan_compat
  CHECK (
    rate_plan_id IS NULL
    OR event_type = 'RATE_CHANGED'
    OR (restriction_rule_id IS NOT NULL
        AND event_type = 'AVAILABILITY_CHANGED'
        AND resource_kind = 'AVAILABILITY')
  );

-- G. a restriction event is always exactly AVAILABILITY_CHANGED/AVAILABILITY.
ALTER TABLE ari_outbox_store
  ADD CONSTRAINT ari_outbox_store_restriction_event_compat
  CHECK (
    restriction_rule_id IS NULL
    OR (event_type = 'AVAILABILITY_CHANGED' AND resource_kind = 'AVAILABILITY')
  );

-- H. the key version is bound to the event class in the DATABASE: a v1
--    restriction event, a v2 non-restriction event, and any unversioned or
--    arbitrary prefix are all rejected.
ALTER TABLE ari_outbox_store
  ADD CONSTRAINT ari_outbox_store_key_version_compat
  CHECK (
    (restriction_rule_id IS NULL     AND dedupe_key LIKE 'aob:v1:%')
    OR
    (restriction_rule_id IS NOT NULL AND dedupe_key LIKE 'aob:v2:%')
  );

-- Postconditions (0086/0087 precedent): abort the whole migration
-- transaction if any promise above did not actually take effect, or if
-- anything that must be preserved was disturbed.
DO $$
DECLARE
  v_def TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ari_outbox_store'
       AND column_name='restriction_rule_id' AND is_nullable='YES'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: restriction_rule_id missing or not nullable';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ari_outbox_store'
       AND column_name='room_type_id' AND is_nullable='NO'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: room_type_id is still NOT NULL';
  END IF;

  -- restriction_rule_id must carry NO foreign key (history outlives the rule).
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (con.conkey)
     WHERE c.relname='ari_outbox_store' AND con.contype='f'
       AND a.attname='restriction_rule_id'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: restriction_rule_id must not have a foreign key';
  END IF;

  FOR v_def IN
    SELECT con.conname FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname='ari_outbox_store'
       AND con.conname IN ('ari_outbox_store_restriction_rule_id_nonempty',
                           'ari_outbox_store_room_type_nonempty',
                           'ari_outbox_store_room_type_required',
                           'ari_outbox_store_rate_plan_compat',
                           'ari_outbox_store_restriction_event_compat',
                           'ari_outbox_store_key_version_compat')
  LOOP
    NULL;
  END LOOP;
  IF (SELECT count(*) FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname='ari_outbox_store'
         AND con.conname IN ('ari_outbox_store_restriction_rule_id_nonempty',
                             'ari_outbox_store_room_type_nonempty',
                             'ari_outbox_store_room_type_required',
                             'ari_outbox_store_rate_plan_compat',
                             'ari_outbox_store_restriction_event_compat',
                             'ari_outbox_store_key_version_compat')) <> 6 THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: not all six restriction-scope CHECK constraints are present';
  END IF;

  SELECT pg_get_constraintdef(con.oid) INTO v_def
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
   WHERE c.relname='ari_outbox_store' AND con.conname='ari_outbox_store_key_version_compat';
  IF v_def NOT LIKE '%aob:v1:%' OR v_def NOT LIKE '%aob:v2:%' THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: key-version CHECK does not bind both aob:v1 and aob:v2';
  END IF;

  -- Everything below must be UNCHANGED by this migration.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname='ari_outbox_store' AND con.conname='uq_aob_logical_event' AND con.contype='u'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: uq_aob_logical_event missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename='ari_outbox_store' AND indexdef LIKE 'CREATE UNIQUE%' AND indexdef LIKE '%WHERE%'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: a partial unique idempotency index appeared';
  END IF;

  IF NOT (
    SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relname='ari_outbox_store'
  ) OR NOT (
    SELECT c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relname='ari_outbox_store'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: RLS or FORCE RLS is no longer enabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='ari_outbox_store'
       AND policyname='ari_outbox_store_by_app'
       AND qual IS NOT NULL AND with_check IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: the tenant policy lost its USING or WITH CHECK';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname='ari_outbox_store'
       AND con.conname='ari_outbox_store_property_same_tenant_fk' AND con.contype='f'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: the same-tenant composite property FK is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname='properties' AND con.conname='uq_properties_tenant_property' AND con.contype='u'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: uq_properties_tenant_property is missing';
  END IF;

  IF (SELECT count(*) FROM pg_indexes
       WHERE tablename='ari_outbox_store'
         AND indexname IN ('idx_aob_claim','idx_aob_retry_due','idx_aob_lease_expiry')) <> 3 THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: a claim/retry/lease index is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ari_outbox_store' AND column_name='reservation_id'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: ari_outbox_store must never carry reservation_id';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname='channel_sync_queue_store'
       AND con.conname='channel_sync_queue_store_status_check'
       AND pg_get_constraintdef(con.oid) LIKE '%DEAD_LETTER%'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: channel_sync_queue_store was disturbed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname='qyrvia_auth_resolver' AND (rolcanlogin OR rolsuper OR NOT rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: qyrvia_auth_resolver role attributes changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee='qyrvia_auth_resolver' AND table_schema='public' AND table_name='ari_outbox_store'
  ) THEN
    RAISE EXCEPTION 'phase66a_b2nc2 postcondition failed: ari_outbox_store must not be granted to the resolver role';
  END IF;
END;
$$;
