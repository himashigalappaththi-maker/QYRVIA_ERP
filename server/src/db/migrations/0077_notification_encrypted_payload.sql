-- Phase 58 — Encrypted identity-email payload columns for notification rows
-- 0077_notification_encrypted_payload.sql
--
-- Adds AES-256-GCM envelope columns so that invitation and password-reset
-- tokens are never stored in plaintext on any notification row.
--
-- Encrypted payload anatomy:
--   encrypted_payload           TEXT        — AES-256-GCM ciphertext, base64
--   encryption_iv               VARCHAR(24) — 12-byte IV, base64 (16 chars)
--   encryption_tag              VARCHAR(32) — 16-byte auth tag, base64 (24 chars)
--   encryption_payload_version  SMALLINT    — payload schema version (currently 1)
--   encryption_key_version      VARCHAR(40) — key-rotation label (e.g. '1')
--
-- source_idempotency_key: stable enqueue-dedup key derived from the identity
--   record ID (invitation ID or reset-token ID), never from the token itself
--   or the email address.  The partial unique index ensures one notification
--   per (tenant, source key) without affecting NULL rows.
--
-- On successful delivery or terminal failure both the worker SQL and the
-- markNotificationDelivered / markNotificationFailed repo methods clear all
-- five encryption columns atomically, leaving no payload residue.

BEGIN;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS encrypted_payload           TEXT,
  ADD COLUMN IF NOT EXISTS encryption_iv               VARCHAR(24),
  ADD COLUMN IF NOT EXISTS encryption_tag              VARCHAR(32),
  ADD COLUMN IF NOT EXISTS encryption_payload_version  SMALLINT,
  ADD COLUMN IF NOT EXISTS encryption_key_version      VARCHAR(40),
  ADD COLUMN IF NOT EXISTS source_idempotency_key      VARCHAR(255);

-- Enqueue-deduplication: one notification per (tenant, source_idempotency_key).
-- Partial so existing NULL rows are unaffected and no existing index conflicts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_source_idempotency_key
  ON notifications (tenant_id, source_idempotency_key)
  WHERE source_idempotency_key IS NOT NULL;

COMMIT;
