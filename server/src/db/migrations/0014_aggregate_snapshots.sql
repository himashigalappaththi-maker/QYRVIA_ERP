-- QYRVIA Phase 4 - aggregate snapshots.
-- Reduces replay cost for long-lived aggregates (reservation, folio, etc.).
-- aggregate_id + aggregate_type uniquely identify a stream; snapshots store
-- the materialised state at a given version. Replay = load latest snapshot +
-- replay events from snapshot.version + 1 onward.

CREATE TABLE aggregate_snapshots (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID         NOT NULL REFERENCES tenants(id),
  aggregate_type    VARCHAR(80)  NOT NULL,
  aggregate_id      VARCHAR(64)  NOT NULL,
  aggregate_version INTEGER      NOT NULL,
  snapshot_json     JSONB        NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- One row per aggregate at most (we overwrite on append-with-snapshot)
CREATE UNIQUE INDEX ux_aggregate_snapshots_one_per
  ON aggregate_snapshots(tenant_id, aggregate_type, aggregate_id);
CREATE INDEX idx_aggregate_snapshots_lookup
  ON aggregate_snapshots(aggregate_type, aggregate_id, aggregate_version DESC);

ALTER TABLE aggregate_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE aggregate_snapshots FORCE  ROW LEVEL SECURITY;
CREATE POLICY aggregate_snapshots_by_app ON aggregate_snapshots
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- event_store: we will rely on (aggregate_type, aggregate_id, event_version)
-- being monotonic. Add a unique index to enforce optimistic concurrency.
CREATE UNIQUE INDEX ux_event_store_version
  ON event_store(tenant_id, aggregate_type, aggregate_id, event_version);
