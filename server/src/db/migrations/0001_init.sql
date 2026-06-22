-- QYRVIA Phase 1 - initial schema.
-- Tenants, properties, append-only audit event store, schema_migrations.
-- Row-Level Security is ENABLED on tenant-scoped tables; policies are added
-- in Phase 3 (Auth). The application contract is already correct from Phase 1
-- via db/client.js withTenant() helper.

-- ============================================================================
-- Extensions (explicit Postgres - required by the brief)
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- uuid_generate_v4() fallback

-- ============================================================================
-- schema_migrations - tracks which versions have been applied
-- ============================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(64)  PRIMARY KEY,
  applied_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ============================================================================
-- tenants - top-level multi-tenant boundary
-- ============================================================================
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        VARCHAR(32)  UNIQUE NOT NULL,
  name        VARCHAR(200) NOT NULL,
  status      VARCHAR(16)  NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ============================================================================
-- properties - hotels/resorts owned by a tenant
-- ============================================================================
CREATE TABLE properties (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code        VARCHAR(32)  NOT NULL,
  name        VARCHAR(200) NOT NULL,
  city        VARCHAR(100),
  currency    CHAR(3)      NOT NULL DEFAULT 'LKR',
  active      BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX idx_properties_tenant ON properties(tenant_id);

-- ============================================================================
-- audit_events - append-only event store.
-- Every domain event published via core/eventBus.js lands here.
-- No UPDATE, no DELETE. Application code only INSERTs (eventBus.js has no
-- UPDATE/DELETE paths). When auth lands in Phase 3 we will REVOKE
-- UPDATE/DELETE on this table at the role level.
-- ============================================================================
CREATE TABLE audit_events (
  event_id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      VARCHAR(120) NOT NULL,
  aggregate_type  VARCHAR(80)  NOT NULL,
  aggregate_id    VARCHAR(64)  NOT NULL,
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  property_id     UUID         REFERENCES properties(id),
  actor_id        UUID,
  request_id      VARCHAR(64),
  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_events_tenant_time ON audit_events(tenant_id, occurred_at DESC);
CREATE INDEX idx_audit_events_type_time   ON audit_events(event_type, occurred_at DESC);
CREATE INDEX idx_audit_events_aggregate   ON audit_events(aggregate_type, aggregate_id);
CREATE INDEX idx_audit_events_payload_gin ON audit_events USING GIN (payload);

-- ============================================================================
-- Row-Level Security - enabled now, policies arrive in Phase 3 (Auth)
-- ============================================================================
ALTER TABLE tenants       ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants       FORCE  ROW LEVEL SECURITY;
ALTER TABLE properties    FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit_events  FORCE  ROW LEVEL SECURITY;

-- Until policies land, allow the connecting role to see everything so app code
-- works against the schema. The withTenant() helper already issues
-- `SET LOCAL app.tenant_id` on every transaction, so Phase 3 only has to add
-- policies of the form:
--   USING (tenant_id::text = current_setting('app.tenant_id', true))
CREATE POLICY tenants_phase1_open      ON tenants      USING (true);
CREATE POLICY properties_phase1_open   ON properties   USING (true);
CREATE POLICY audit_events_phase1_open ON audit_events USING (true);
