-- QYRVIA Phase 5 - Rate Plan foundation.
-- Framework only - no Revenue Management logic. Supports seasonal periods +
-- occupancy + child + extra-bed pricing.

CREATE TABLE rate_plans (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  property_id  UUID         NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  code         VARCHAR(40)  NOT NULL,
  name         VARCHAR(200) NOT NULL,
  description  TEXT,
  currency     CHAR(3)      NOT NULL DEFAULT 'LKR',
  base_rate    NUMERIC(12,2) NOT NULL DEFAULT 0,
  active       BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by   UUID,
  CHECK (base_rate >= 0)
);
CREATE UNIQUE INDEX ux_rate_plans_code ON rate_plans(property_id, code);

CREATE TABLE rate_plan_periods (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  rate_plan_id UUID         NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
  name         VARCHAR(120),                 -- e.g. 'Christmas Peak'
  date_from    DATE         NOT NULL,
  date_to      DATE         NOT NULL,
  rate         NUMERIC(12,2) NOT NULL,
  CHECK (date_to >= date_from),
  CHECK (rate >= 0)
);
CREATE INDEX idx_rate_plan_periods_plan ON rate_plan_periods(rate_plan_id, date_from);

CREATE TABLE rate_plan_pricing (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  rate_plan_id    UUID         NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
  -- Type of pricing line. OCCUPANCY = N adults; CHILD_CATEGORY = child age cat; EXTRA_BED = extra bed
  pricing_type    VARCHAR(40)  NOT NULL CHECK (pricing_type IN ('OCCUPANCY','CHILD_CATEGORY','EXTRA_BED')),
  -- For OCCUPANCY: occupancy number (e.g. 1, 2, 3). For CHILD_CATEGORY: child_age_category code. For EXTRA_BED: NULL.
  occupancy_count INTEGER,
  child_category_code VARCHAR(40),
  rate            NUMERIC(12,2) NOT NULL DEFAULT 0,
  rate_pct        NUMERIC(5,2),                                  -- alternative: percentage of base
  CHECK (rate >= 0 AND (rate_pct IS NULL OR rate_pct >= 0))
);
CREATE INDEX idx_rate_plan_pricing_plan ON rate_plan_pricing(rate_plan_id, pricing_type);

ALTER TABLE rate_plans         ENABLE ROW LEVEL SECURITY; ALTER TABLE rate_plans         FORCE ROW LEVEL SECURITY;
ALTER TABLE rate_plan_periods  ENABLE ROW LEVEL SECURITY; ALTER TABLE rate_plan_periods  FORCE ROW LEVEL SECURITY;
ALTER TABLE rate_plan_pricing  ENABLE ROW LEVEL SECURITY; ALTER TABLE rate_plan_pricing  FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_plans_by_app        ON rate_plans        USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY rate_plan_periods_by_app ON rate_plan_periods USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY rate_plan_pricing_by_app ON rate_plan_pricing USING (tenant_id::text = current_setting('app.tenant_id', true));

-- Now we can wire reservations.rate_plan_id FK
ALTER TABLE reservations
  ADD CONSTRAINT fk_reservations_rate_plan
  FOREIGN KEY (rate_plan_id) REFERENCES rate_plans(id) ON DELETE RESTRICT;
