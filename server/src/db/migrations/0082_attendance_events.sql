-- Phase 59: Attendance events table — event-based check-in / check-out only.
-- No continuous tracking. No background GPS collection.
-- Geographic evidence is OPTIONAL and recorded only at the explicit event time.
-- RLS uses app_current_tenant() (defined migration 0051).

CREATE TABLE IF NOT EXISTS attendance_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id),
  property_id      UUID        NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  user_id          UUID        NOT NULL,
  event_type       TEXT        NOT NULL
                               CHECK (event_type IN ('check_in','check_out')),
  event_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  source           TEXT        NOT NULL DEFAULT 'manual'
                               CHECK (source IN ('manual','gate','patrol','mobile_event')),
  latitude         NUMERIC(9,6),
  longitude        NUMERIC(9,6),
  accuracy_meters  NUMERIC(8,2),
  patrol_point_id  UUID        REFERENCES patrol_points(id) ON DELETE SET NULL,
  gate_reference   TEXT,
  device_reference TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT attendance_events_lat_range
    CHECK (latitude  IS NULL OR (latitude  BETWEEN -90  AND  90)),
  CONSTRAINT attendance_events_lng_range
    CHECK (longitude IS NULL OR (longitude BETWEEN -180 AND 180)),
  CONSTRAINT attendance_events_acc_range
    CHECK (accuracy_meters IS NULL OR (accuracy_meters BETWEEN 0 AND 10000))
);

ALTER TABLE attendance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_events FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attendance_events_tenant_isolation ON attendance_events;
CREATE POLICY attendance_events_tenant_isolation ON attendance_events
  USING  (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS attendance_events_tenant_idx
  ON attendance_events (tenant_id);
CREATE INDEX IF NOT EXISTS attendance_events_property_user_idx
  ON attendance_events (property_id, user_id);
CREATE INDEX IF NOT EXISTS attendance_events_user_event_at_idx
  ON attendance_events (user_id, event_at DESC);
CREATE INDEX IF NOT EXISTS attendance_events_event_at_idx
  ON attendance_events (event_at DESC);
