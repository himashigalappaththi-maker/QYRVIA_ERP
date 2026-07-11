BEGIN;

-- Phase 57: Tenant user invitation workflow.
--
-- Flow:
--   A platform_admin or tenant owner creates an invitation for an email address.
--   A secure random token is generated; only its SHA-256 hash is stored here.
--   The raw token is delivered out-of-band (email / notification outbox).
--   On acceptance, the user sets a password and the invitation is marked accepted.
--   Only one active (pending) invitation per (tenant, normalised email) at a time.

CREATE TYPE invitation_status AS ENUM (
    'pending',
    'accepted',
    'expired',
    'revoked'
);

CREATE TABLE user_invitations (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    email        VARCHAR(200) NOT NULL,
    -- SHA-256 hex digest of the raw invitation token. Raw token never stored.
    token_hash   VARCHAR(64)  NOT NULL UNIQUE,
    invited_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
    role_codes   TEXT[]       NOT NULL DEFAULT '{}',
    property_ids UUID[]       NOT NULL DEFAULT '{}',
    status       invitation_status NOT NULL DEFAULT 'pending',
    expires_at   TIMESTAMPTZ  NOT NULL,
    accepted_at  TIMESTAMPTZ,
    accepted_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
    revoked_at   TIMESTAMPTZ,
    revoked_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Only one pending invitation per (tenant, normalised email) at a time.
-- Accepted / expired / revoked invitations are allowed to coexist so the
-- audit trail is preserved.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitation_active_email
    ON user_invitations (tenant_id, lower(email))
 WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_invitation_token_hash
    ON user_invitations (token_hash);

CREATE INDEX IF NOT EXISTS idx_invitation_tenant_status
    ON user_invitations (tenant_id, status);

-- RLS: tenant isolation via the SARGable app_current_tenant() function
-- established in migration 0051.
ALTER TABLE user_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_invitations FORCE  ROW LEVEL SECURITY;

CREATE POLICY inv_tenant_isolation ON user_invitations
    USING      (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

COMMIT;
