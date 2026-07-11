BEGIN;

-- Phase 57: Password reset token infrastructure.
--
-- The users table already carries the PENDING_PASSWORD_RESET status enum value
-- (migration 0002) but had no supporting token table.
--
-- Flow:
--   User requests a reset → a secure random token is generated, its SHA-256
--   hash stored here, raw token delivered out-of-band.
--   On completion the token is marked used, the user's password_hash is
--   updated, and all existing refresh_tokens for the user are revoked.
--
-- Only one active (pending) reset token per user at a time (partial unique
-- index). A new request supersedes the previous one by marking the old
-- token revoked before inserting a new one.

CREATE TYPE reset_token_status AS ENUM (
    'pending',
    'used',
    'expired',
    'revoked'
);

CREATE TABLE password_reset_tokens (
    id         UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID              NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id  UUID              NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    -- SHA-256 hex digest of the raw reset token. Raw token never stored.
    token_hash VARCHAR(64)       NOT NULL UNIQUE,
    status     reset_token_status NOT NULL DEFAULT 'pending',
    expires_at TIMESTAMPTZ       NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ       NOT NULL DEFAULT now()
);

-- Enforce at most one pending reset token per user. A second request must
-- revoke/expire the first before inserting, enforced at the application layer
-- using this index as a hard guard.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reset_active_per_user
    ON password_reset_tokens (user_id)
 WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_reset_token_hash
    ON password_reset_tokens (token_hash);

-- RLS: tenant isolation via the SARGable app_current_tenant() function.
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE  ROW LEVEL SECURITY;

CREATE POLICY prt_tenant_isolation ON password_reset_tokens
    USING      (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

COMMIT;
