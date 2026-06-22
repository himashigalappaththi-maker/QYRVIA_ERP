-- QYRVIA Phase 6 - Settings catalog.
--
-- WHY: Every future module reads tunables from `settings`. Without a
-- typed catalog there is no way to validate a settings PUT, render a
-- settings UI, or detect drift from approved values. This table is the
-- single source of truth for which (category, key) pairs are valid and
-- what value shape they accept.
--
-- The catalog itself is registered IN CODE at boot time via
-- `settingsService.register(...)`. This migration provides only the
-- persistence shape. Unknown keys are still accepted by `settings.upsertSetting`
-- (backward compatibility); the validator only enforces shape WHEN a key
-- has been registered.

CREATE TABLE settings_schema (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  category            VARCHAR(40)  NOT NULL,
  key                 VARCHAR(80)  NOT NULL,
  value_type          VARCHAR(20)  NOT NULL CHECK (value_type IN
                        ('boolean','int','number','string','json','enum','duration_seconds')),
  default_value_json  JSONB,
  enum_values         TEXT[],
  description         TEXT,
  requires_permission VARCHAR(80),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (category, key)
);
CREATE INDEX idx_settings_schema_category ON settings_schema(category);

-- The catalog is global (not tenant-scoped) because schema definitions
-- describe the SHAPE of values, not the values themselves. RLS not needed.
-- However we keep PUBLIC read-only to mirror other catalog tables.

INSERT INTO permissions (code, description) VALUES
  ('settings.schema.read', 'View the settings catalog (schema)')
ON CONFLICT (code) DO NOTHING;

-- Grant settings.schema.read to every role that already holds settings.read.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, p2.id
  FROM role_permissions rp
  JOIN permissions p1 ON p1.id = rp.permission_id AND p1.code = 'settings.read'
  CROSS JOIN permissions p2
 WHERE p2.code = 'settings.schema.read'
ON CONFLICT DO NOTHING;
