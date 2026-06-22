-- QYRVIA Phase 6 / C4 - Meal Policy Engine.
--
-- WHY: Every reservation implicitly assumes a meal-plan basis (RO/BB/HB/FB/AI).
-- Today this lives only inside rate_plan pricing, with no first-class entity.
-- Without this table, the Folio module (Phase 7) cannot determine whether
-- a guest's breakfast posting is "included" or "to be charged"; the AI
-- WhatsApp Booking Agent (Phase 15) cannot present meal plan options at
-- booking; channel mappings (mapping_kind='MEAL_PLAN', migration 0026)
-- have no local id to map TO.
--
-- The aggregate is property-scoped + RLS-protected + audit-enabled.

CREATE TYPE meal_plan_basis AS ENUM ('RO','BB','HB','FB','AI','CUSTOM');

CREATE TABLE meal_plans (
  id                 UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID            NOT NULL REFERENCES tenants(id),
  property_id        UUID            NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  code               VARCHAR(20)     NOT NULL,
  name               VARCHAR(200)    NOT NULL,
  basis              meal_plan_basis NOT NULL,
  includes_breakfast BOOLEAN         NOT NULL DEFAULT false,
  includes_lunch     BOOLEAN         NOT NULL DEFAULT false,
  includes_dinner    BOOLEAN         NOT NULL DEFAULT false,
  includes_snack     BOOLEAN         NOT NULL DEFAULT false,
  adult_rate         NUMERIC(12,2)   NOT NULL DEFAULT 0,
  child_rate         NUMERIC(12,2)   NOT NULL DEFAULT 0,
  currency           CHAR(3)         NOT NULL DEFAULT 'LKR',
  active             BOOLEAN         NOT NULL DEFAULT true,
  description        TEXT,
  created_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),
  created_by         UUID,
  UNIQUE (property_id, code)
);
CREATE INDEX idx_meal_plans_tenant_property ON meal_plans(tenant_id, property_id);

ALTER TABLE meal_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_plans FORCE  ROW LEVEL SECURITY;
CREATE POLICY meal_plans_by_app ON meal_plans
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- Link rate_plans -> meal_plans (nullable so existing rate plans remain valid).
ALTER TABLE rate_plans
  ADD COLUMN IF NOT EXISTS meal_plan_id UUID REFERENCES meal_plans(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_rate_plans_meal_plan
  ON rate_plans(meal_plan_id) WHERE meal_plan_id IS NOT NULL;

-- Permissions.
INSERT INTO permissions (code, description) VALUES
  ('pms.mealplan.read',  'Read meal plans'),
  ('pms.mealplan.write', 'Create / update meal plans and attach them to rate plans')
ON CONFLICT (code) DO NOTHING;

-- Grant to standard PMS roles.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('corporate_admin','property_admin','front_office_manager')
  AND p.code IN ('pms.mealplan.read','pms.mealplan.write')
ON CONFLICT DO NOTHING;
