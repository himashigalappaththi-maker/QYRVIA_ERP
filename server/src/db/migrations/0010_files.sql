-- QYRVIA Phase 3 - file storage metadata.
-- Phase 3 stores blobs on local filesystem rooted at STORAGE_ROOT.
-- The table is provider-agnostic so a later phase can swap to S3/GCS by
-- changing storage_provider + storage_key semantics with zero schema change.

CREATE TYPE file_status AS ENUM ('available','deleted','quarantined');

CREATE TABLE files (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID         NOT NULL REFERENCES tenants(id),
  property_id      UUID         REFERENCES properties(id),
  file_name        VARCHAR(255) NOT NULL,
  mime_type        VARCHAR(120) NOT NULL,
  file_size        BIGINT       NOT NULL,
  sha256           VARCHAR(64)  NOT NULL,         -- content hash for dedupe / integrity check
  storage_provider VARCHAR(40)  NOT NULL DEFAULT 'local',
  storage_key      VARCHAR(255) NOT NULL,         -- file path under STORAGE_ROOT (or object key on cloud)
  status           file_status  NOT NULL DEFAULT 'available',
  uploaded_by      UUID,
  uploaded_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX idx_files_tenant_status ON files(tenant_id, status);
CREATE INDEX idx_files_sha256        ON files(sha256);

ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE  ROW LEVEL SECURITY;
CREATE POLICY files_by_app ON files
  USING (tenant_id::text = current_setting('app.tenant_id', true));
