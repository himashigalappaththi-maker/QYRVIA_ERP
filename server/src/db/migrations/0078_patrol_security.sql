-- M1A: Security patrol points and check-in logs.
-- Additive. Backs the existing server/src/routes/patrol.js contract
-- (patrolRepo.listPoints / createPoint / togglePoint / listLogs / createLog),
-- introduced by Phase 48 with no DB-backed repository until now.
--
-- M1A correction round: patrol points/logs are physical-property operational
-- records, so property_id is mandatory (NOT NULL + FK) on both tables rather
-- than optional. Every application-level query additionally filters by an
-- authorized property_id resolved server-side (see
-- server/src/db/repos.js#_resolveAuthorizedPropertyId) - RLS below remains
-- tenant-scoped only, consistent with this codebase's existing convention
-- (property-level enforcement is an application-layer concern; see
-- server/src/middleware/identityContext.js and
-- server/src/platform/iam/PropertyContext.js, Phase 31.5).

CREATE TABLE IF NOT EXISTS patrol_points (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id),
  property_id UUID        NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  name        TEXT        NOT NULL,
  zone        TEXT        NOT NULL DEFAULT 'Exterior',
  lat         NUMERIC(10,6),
  lng         NUMERIC(10,6),
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE patrol_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE patrol_points FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS patrol_points_tenant_isolation ON patrol_points;
CREATE POLICY patrol_points_tenant_isolation ON patrol_points
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS patrol_points_tenant_idx   ON patrol_points (tenant_id);
CREATE INDEX IF NOT EXISTS patrol_points_property_idx ON patrol_points (property_id);
CREATE INDEX IF NOT EXISTS patrol_points_active_idx   ON patrol_points (active);

CREATE TABLE IF NOT EXISTS patrol_logs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id),
  property_id UUID        NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  point_id    UUID        NOT NULL REFERENCES patrol_points(id) ON DELETE RESTRICT,
  officer_id  UUID        NOT NULL,
  gps_lat     NUMERIC(10,6),
  gps_lng     NUMERIC(10,6),
  gps_acc     TEXT,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE patrol_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE patrol_logs FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS patrol_logs_tenant_isolation ON patrol_logs;
CREATE POLICY patrol_logs_tenant_isolation ON patrol_logs
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

CREATE INDEX IF NOT EXISTS patrol_logs_tenant_idx   ON patrol_logs (tenant_id);
CREATE INDEX IF NOT EXISTS patrol_logs_property_idx ON patrol_logs (property_id);
CREATE INDEX IF NOT EXISTS patrol_logs_point_idx    ON patrol_logs (point_id);
CREATE INDEX IF NOT EXISTS patrol_logs_officer_idx  ON patrol_logs (officer_id);
CREATE INDEX IF NOT EXISTS patrol_logs_checked_idx  ON patrol_logs (checked_at);

-- Defence-in-depth: a patrol log's point must belong to the SAME property as
-- the log itself (not just the same tenant). The application layer already
-- enforces this atomically at INSERT time (repos.js createLog uses
-- INSERT ... SELECT ... WHERE EXISTS against patrol_points scoped to the same
-- tenant_id + property_id). This trigger is a second, DB-level guarantee that
-- holds even for writes that bypass the application (e.g. manual SQL, future
-- code paths), so cross-property point/log pairing can never be persisted.
CREATE OR REPLACE FUNCTION patrol_logs_point_property_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM patrol_points pp
     WHERE pp.id = NEW.point_id
       AND pp.tenant_id = NEW.tenant_id
       AND pp.property_id = NEW.property_id
  ) THEN
    RAISE EXCEPTION 'patrol_logs: point_id % does not belong to tenant % / property %',
      NEW.point_id, NEW.tenant_id, NEW.property_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS patrol_logs_point_property_guard_trg ON patrol_logs;
CREATE TRIGGER patrol_logs_point_property_guard_trg
  BEFORE INSERT OR UPDATE ON patrol_logs
  FOR EACH ROW EXECUTE FUNCTION patrol_logs_point_property_guard();
