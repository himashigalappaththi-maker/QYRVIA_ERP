BEGIN;

-- Phase 57: Make email a NOT-NULL, globally case-insensitive unique
-- primary identifier for customer SaaS login.
--
-- Strategy:
--   1. Backfill any NULL emails (bootstrap/seed users) with a placeholder
--      so the NOT NULL constraint can be applied cleanly.
--   2. Set NOT NULL on the column.
--   3. Add email_verified_at for future email verification workflow.
--   4. Drop the old case-sensitive per-tenant unique constraint (0002).
--   5. Create a global case-insensitive unique index so the same email
--      cannot exist in two different tenants — required for email-only
--      SaaS login where the tenant is not known up front.

UPDATE users
   SET email      = 'bootstrap-' || id || '@qyrvia.internal',
       updated_at = now()
 WHERE email IS NULL;

ALTER TABLE users ALTER COLUMN email SET NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Drop the old case-sensitive per-tenant unique constraint created in 0002.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tenant_id_email_key;

-- Global case-insensitive unique index. Excludes soft-deleted rows so that
-- a deleted user's email can be reused for a fresh invitation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_global
    ON users (lower(email))
 WHERE soft_deleted_at IS NULL;

-- Existing RLS from migration 0051 (users_tenant_isolation using
-- app_current_tenant()) already covers this table. No new policy needed.

COMMIT;
