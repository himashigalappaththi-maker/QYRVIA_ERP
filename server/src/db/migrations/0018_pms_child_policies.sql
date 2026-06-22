-- QYRVIA Phase 5 - Child Policy Engine.
-- Property-configurable, no hardcoded rules. A child policy bundle owns
-- a set of age categories; each category carries the stay/meal/occupancy/
-- extra-bed rules expressed numerically.

CREATE TABLE child_policies (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  property_id  UUID         NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  code         VARCHAR(40)  NOT NULL,
  name         VARCHAR(200) NOT NULL,
  description  TEXT,
  active       BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by   UUID
);
CREATE UNIQUE INDEX ux_child_policies_code ON child_policies(property_id, code);

CREATE TABLE child_age_categories (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES tenants(id),
  child_policy_id     UUID         NOT NULL REFERENCES child_policies(id) ON DELETE CASCADE,
  code                VARCHAR(40)  NOT NULL,                    -- e.g. INFANT, CHILD_A, CHILD_B
  name                VARCHAR(120) NOT NULL,
  age_from            INTEGER      NOT NULL,                    -- inclusive
  age_to              INTEGER      NOT NULL,                    -- inclusive
  -- Stay policy: charge as % of adult rate. 0 = free.
  stay_charge_pct     NUMERIC(5,2) NOT NULL DEFAULT 0,
  -- Meal policy: charge as % of adult meal rate.
  meal_charge_pct     NUMERIC(5,2) NOT NULL DEFAULT 0,
  -- Occupancy: does this child count against room max_occupancy?
  counts_in_occupancy BOOLEAN      NOT NULL DEFAULT false,
  -- Extra bed: does this category trigger an extra-bed charge?
  requires_extra_bed  BOOLEAN      NOT NULL DEFAULT false,
  extra_bed_charge    NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (age_from >= 0 AND age_to >= age_from),
  CHECK (stay_charge_pct >= 0 AND meal_charge_pct >= 0)
);
CREATE UNIQUE INDEX ux_child_age_categories_code ON child_age_categories(child_policy_id, code);
CREATE INDEX idx_child_age_categories_range ON child_age_categories(child_policy_id, age_from, age_to);

ALTER TABLE child_policies        ENABLE ROW LEVEL SECURITY; ALTER TABLE child_policies        FORCE ROW LEVEL SECURITY;
ALTER TABLE child_age_categories  ENABLE ROW LEVEL SECURITY; ALTER TABLE child_age_categories  FORCE ROW LEVEL SECURITY;
CREATE POLICY child_policies_by_app       ON child_policies       USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY child_age_categories_by_app ON child_age_categories USING (tenant_id::text = current_setting('app.tenant_id', true));
