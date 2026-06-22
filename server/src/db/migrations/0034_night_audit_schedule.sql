-- QYRVIA Phase 6 / C13 - Night Audit Scheduler + Stale-Date helper index.
--
-- WHY: §2.4 (Automatic Day-End scheduler) + §2.6 (Business Date Not Closed
-- alerts) require:
--   * a cron-style recurring job per property that dispatches
--     pms.night_audit.run at the configured time/timezone;
--   * a server-side sweep that detects properties whose
--     current_business_date is older than `night_audit.stale_threshold_hours`
--     and emits a business_date.stale_detected event.
--
-- Both use the existing scheduler (Phase 3) - no new table needed. This
-- migration only adds an index so the sweep stays O(log n).

CREATE INDEX IF NOT EXISTS idx_properties_business_date
  ON properties(current_business_date)
  WHERE current_business_date IS NOT NULL;

-- Permission for the periodic stale-check job (system-emitted; we declare
-- it so a future operator dashboard route can require it for read).
INSERT INTO permissions (code, description) VALUES
  ('business_date.stale.read', 'View business-date staleness alerts')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('corporate_admin','property_admin','front_office_manager')
  AND p.code = 'business_date.stale.read'
ON CONFLICT DO NOTHING;
