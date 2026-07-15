-- Phase 59: Maintenance work orders table.
-- Tenant-owned, property-scoped operational records.
-- RLS uses app_current_tenant() (defined migration 0051).

CREATE TABLE IF NOT EXISTS maintenance_work_orders (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID        NOT NULL REFERENCES tenants(id),
  property_id          UUID        NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  work_order_number    TEXT        NOT NULL,
  asset_or_location    TEXT,
  category             TEXT        NOT NULL DEFAULT 'General'
                                   CHECK (category IN (
                                     'Electrical','Plumbing','HVAC','Structural',
                                     'Mechanical','IT','Cleaning','Landscaping',
                                     'Safety','General'
                                   )),
  priority             TEXT        NOT NULL DEFAULT 'medium'
                                   CHECK (priority IN ('low','medium','high','urgent')),
  title                TEXT        NOT NULL,
  description          TEXT,
  reported_by_user_id  UUID        NOT NULL,
  assigned_to_user_id  UUID,
  status               TEXT        NOT NULL DEFAULT 'open'
                                   CHECK (status IN ('open','assigned','in_progress','on_hold','completed','cancelled')),
  due_at               TIMESTAMPTZ,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  resolution_notes     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE maintenance_work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_work_orders FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS maintenance_work_orders_tenant_isolation ON maintenance_work_orders;
CREATE POLICY maintenance_work_orders_tenant_isolation ON maintenance_work_orders
  USING  (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

CREATE UNIQUE INDEX IF NOT EXISTS maintenance_work_orders_number_idx
  ON maintenance_work_orders (tenant_id, work_order_number);
CREATE INDEX IF NOT EXISTS maintenance_work_orders_tenant_idx
  ON maintenance_work_orders (tenant_id);
CREATE INDEX IF NOT EXISTS maintenance_work_orders_property_status_idx
  ON maintenance_work_orders (property_id, status);
CREATE INDEX IF NOT EXISTS maintenance_work_orders_assigned_idx
  ON maintenance_work_orders (assigned_to_user_id) WHERE assigned_to_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS maintenance_work_orders_due_idx
  ON maintenance_work_orders (due_at) WHERE due_at IS NOT NULL;
