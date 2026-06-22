-- QYRVIA Phase 3 - enterprise settings service.
-- property_id NULL => tenant-wide; property_id non-null => property-scoped.
-- A tenant-wide value can be overridden at the property level by inserting a
-- row with the same category+key and a property_id. settingsService.get()
-- resolves the most-specific row.

CREATE TABLE settings (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  property_id  UUID         REFERENCES properties(id),
  category     VARCHAR(80)  NOT NULL,
  key          VARCHAR(120) NOT NULL,
  value_json   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  updated_by   UUID,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- Expression-based unique index (PG forbids expressions inside UNIQUE constraints)
CREATE UNIQUE INDEX ux_settings_unique ON settings
  (tenant_id, COALESCE(property_id, '00000000-0000-0000-0000-000000000000'::uuid), category, key);
CREATE INDEX idx_settings_lookup ON settings(tenant_id, category, key);

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings FORCE  ROW LEVEL SECURITY;
CREATE POLICY settings_by_app ON settings
  USING (tenant_id::text = current_setting('app.tenant_id', true));
