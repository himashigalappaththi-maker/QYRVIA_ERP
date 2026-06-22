-- QYRVIA Phase 6 / Step 5 - property-scoped audit_events index.
--
-- WHY: After Phase 5.5 + 6 every event carries property_id; per-property
-- audit views (operator dashboard, multi-property audit drill-down) were
-- doing a full scan filtered by property_id. This partial index turns
-- those reads into O(log n).

CREATE INDEX IF NOT EXISTS idx_audit_events_property_time
  ON audit_events(property_id, occurred_at DESC)
  WHERE property_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_store_property_time
  ON event_store(property_id, occurred_at DESC)
  WHERE property_id IS NOT NULL;
