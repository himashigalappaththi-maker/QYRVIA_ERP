-- QYRVIA Phase 24 (B8-B1) - secure OTA credential store. DEFINITION ONLY:
-- nothing selects this until OTA connectivity activates. Secrets are stored
-- ENCRYPTED-AT-REST in encrypted_payload (JSONB { iv, tag, ciphertext }); the
-- plaintext credential is NEVER persisted. Per-tenant RLS mirrors event_store.

CREATE TABLE channel_credential_store (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID         NOT NULL REFERENCES tenants(id),
  property_id        UUID         REFERENCES properties(id),
  channel            VARCHAR(60),
  credentials_ref    VARCHAR(200) NOT NULL,
  credential_type    VARCHAR(40)  NOT NULL DEFAULT 'API_KEY'
                       CHECK (credential_type IN ('API_KEY','OAUTH2','HMAC','BASIC')),
  encrypted_payload  JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- { iv, tag, ciphertext } - NEVER plaintext
  key_version        INTEGER      NOT NULL DEFAULT 1,
  status             VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE','ROTATED','REVOKED')),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  rotated_at         TIMESTAMPTZ,
  CONSTRAINT uq_ccreds_ref UNIQUE (tenant_id, credentials_ref)
);
CREATE INDEX idx_ccreds_scope  ON channel_credential_store(tenant_id, property_id, channel);
CREATE INDEX idx_ccreds_status ON channel_credential_store(tenant_id, status);

ALTER TABLE channel_credential_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_credential_store FORCE  ROW LEVEL SECURITY;
CREATE POLICY channel_credential_store_by_app ON channel_credential_store
  USING (tenant_id::text = current_setting('app.tenant_id', true));
