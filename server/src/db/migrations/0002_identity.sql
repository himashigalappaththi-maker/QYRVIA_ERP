-- QYRVIA Phase 2 - identity tables.
-- Adjustments locked in:
--   * roles.scope classification (SYSTEM / TENANT / PROPERTY)  -- adjustment #2
--   * refresh_tokens device + last_used_at + revoked_at tracking -- adjustment #3
--   * users.status enum (replaces active BOOLEAN)              -- adjustment #4
--   * register is admin-only at the route level (no DB change)  -- adjustment #5

-- =========================================================================
-- USERS
-- =========================================================================
CREATE TYPE user_status AS ENUM (
  'ACTIVE',
  'LOCKED',
  'DISABLED',
  'PENDING_PASSWORD_RESET',
  'TERMINATED'
);

CREATE TABLE users (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  username            VARCHAR(64)  NOT NULL,
  email               VARCHAR(200),
  password_hash       VARCHAR(120) NOT NULL,        -- bcrypt-encoded
  full_name           VARCHAR(200) NOT NULL,
  primary_property_id UUID         REFERENCES properties(id),
  status              user_status  NOT NULL DEFAULT 'ACTIVE',
  failed_login_count  INTEGER      NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  soft_deleted_at     TIMESTAMPTZ,
  last_login_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username),
  UNIQUE (tenant_id, email)
);
CREATE INDEX idx_users_tenant ON users(tenant_id) WHERE soft_deleted_at IS NULL;

-- =========================================================================
-- ROLES (global, with scope classification)
-- =========================================================================
CREATE TYPE role_scope AS ENUM (
  'SYSTEM',     -- spans tenants; only super_admin role qualifies
  'TENANT',     -- scoped to a single tenant (default)
  'PROPERTY'    -- scoped to a single property within a tenant
);

CREATE TABLE roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        VARCHAR(40) UNIQUE NOT NULL,
  name        VARCHAR(120) NOT NULL,
  description TEXT,
  scope       role_scope  NOT NULL DEFAULT 'TENANT',
  is_system   BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================================
-- PERMISSIONS (global)
-- =========================================================================
CREATE TABLE permissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        VARCHAR(80) UNIQUE NOT NULL,            -- '<aggregate>.<verb>'
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id       UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

-- =========================================================================
-- USER ROLES (user x role x scope)
-- =========================================================================
-- PG does NOT allow expressions in PRIMARY KEY / UNIQUE constraints. We use a
-- surrogate id PK + a unique partial-expression INDEX to coerce uniqueness
-- across NULL property_id. ON CONFLICT in UPSERTs references the expression
-- list, which matches the index.
CREATE TABLE user_roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  property_id UUID REFERENCES properties(id),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by  UUID REFERENCES users(id)
);
CREATE UNIQUE INDEX ux_user_roles_unique ON user_roles
  (user_id, role_id, tenant_id, COALESCE(property_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX idx_user_roles_user ON user_roles(user_id);
CREATE INDEX idx_user_roles_tenant ON user_roles(tenant_id);

-- =========================================================================
-- REFRESH TOKENS (with device tracking, last_used_at, revoked_at)
-- =========================================================================
CREATE TABLE refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  token_hash   VARCHAR(64) UNIQUE NOT NULL,           -- sha256 hex of opaque token
  device_name  VARCHAR(200),                          -- adjustment #3
  device_id    VARCHAR(120),                          -- adjustment #3
  ip_address   INET,                                  -- adjustment #3 (renamed from ip)
  user_agent   VARCHAR(255),
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,                           -- adjustment #3
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,                           -- adjustment #3 (explicit; was implicit)
  rotated_to   UUID REFERENCES refresh_tokens(id)     -- forms a rotation chain
);
CREATE INDEX idx_refresh_user_active ON refresh_tokens(user_id) WHERE revoked_at IS NULL;

-- =========================================================================
-- RLS - enable on tenant-scoped tables (real policies in 0004)
-- =========================================================================
ALTER TABLE users           ENABLE ROW LEVEL SECURITY; ALTER TABLE users           FORCE ROW LEVEL SECURITY;
ALTER TABLE user_roles      ENABLE ROW LEVEL SECURITY; ALTER TABLE user_roles      FORCE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens  ENABLE ROW LEVEL SECURITY; ALTER TABLE refresh_tokens  FORCE ROW LEVEL SECURITY;

-- Temporary open policies during the brief window between 0002 and 0004
CREATE POLICY users_phase2_open          ON users          USING (true);
CREATE POLICY user_roles_phase2_open     ON user_roles     USING (true);
CREATE POLICY refresh_tokens_phase2_open ON refresh_tokens USING (true);
