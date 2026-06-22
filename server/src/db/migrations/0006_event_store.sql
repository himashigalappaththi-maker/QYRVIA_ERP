-- QYRVIA Phase 3 - persistent event store.
-- Distinct from audit_events: event_store is the canonical domain-event log
-- (source of truth for rebuilding aggregate state); audit_events captures the
-- full audit trail INCLUDING command.attempted / command.denied / etc.
--
-- Every successful domain event is written to BOTH tables. Failure to write
-- to either causes publish() to throw.

CREATE TABLE event_store (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  property_id     UUID         REFERENCES properties(id),
  aggregate_type  VARCHAR(80)  NOT NULL,
  aggregate_id    VARCHAR(64)  NOT NULL,
  event_type      VARCHAR(120) NOT NULL,
  event_version   INTEGER      NOT NULL DEFAULT 1,    -- per-aggregate monotonic version (Phase 3 = always 1; PMS phases will compute)
  payload_json    JSONB        NOT NULL DEFAULT '{}'::jsonb,
  actor_id        UUID,
  request_id      VARCHAR(64),
  occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_store_tenant_time      ON event_store(tenant_id, occurred_at DESC);
CREATE INDEX idx_event_store_aggregate        ON event_store(aggregate_type, aggregate_id);
CREATE INDEX idx_event_store_type_time        ON event_store(event_type, occurred_at DESC);
CREATE INDEX idx_event_store_payload_gin      ON event_store USING GIN (payload_json);

-- RLS - append-only
ALTER TABLE event_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_store FORCE  ROW LEVEL SECURITY;
CREATE POLICY event_store_by_app ON event_store
  USING (tenant_id::text = current_setting('app.tenant_id', true));
REVOKE UPDATE, DELETE ON event_store FROM PUBLIC;
