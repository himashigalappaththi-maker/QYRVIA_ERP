-- QYRVIA Phase 3 - notification framework.
-- Phase 3 ships persistence + delivery attempts only; no real provider integrations.

CREATE TYPE notification_channel AS ENUM ('email','sms','whatsapp','in_app');
CREATE TYPE notification_status  AS ENUM ('pending','sending','delivered','failed','not_configured','cancelled');

CREATE TABLE notification_templates (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  code         VARCHAR(120) NOT NULL,
  channel      notification_channel NOT NULL,
  subject      VARCHAR(200),
  body         TEXT NOT NULL,                    -- with {{handlebars}} placeholders
  locale       VARCHAR(16)  NOT NULL DEFAULT 'en',
  is_active    BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, channel, locale)
);

CREATE TABLE notifications (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id),
  property_id   UUID         REFERENCES properties(id),
  channel       notification_channel NOT NULL,
  template_code VARCHAR(120),                    -- reference to template, optional
  recipient     VARCHAR(200) NOT NULL,           -- email | phone | wa-id | user_id
  subject       VARCHAR(200),
  body          TEXT NOT NULL,                   -- rendered final content
  context       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  status        notification_status NOT NULL DEFAULT 'pending',
  requested_by  UUID,
  requested_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX idx_notifications_tenant_status ON notifications(tenant_id, status);
CREATE INDEX idx_notifications_recipient      ON notifications(recipient);

CREATE TABLE notification_delivery_log (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID         NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  attempt_no      INTEGER      NOT NULL DEFAULT 1,
  status          notification_status NOT NULL,
  provider        VARCHAR(40),                   -- which provider attempted (or null when not_configured)
  provider_ref    VARCHAR(200),                  -- provider message id / receipt
  error           TEXT,
  attempted_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_notif_delivery_notif ON notification_delivery_log(notification_id);

ALTER TABLE notifications              ENABLE ROW LEVEL SECURITY; ALTER TABLE notifications              FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_templates     ENABLE ROW LEVEL SECURITY; ALTER TABLE notification_templates     FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_delivery_log  ENABLE ROW LEVEL SECURITY; ALTER TABLE notification_delivery_log  FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_by_app             ON notifications              USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY notification_templates_by_app    ON notification_templates     USING (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY notification_delivery_log_by_app ON notification_delivery_log  USING (tenant_id::text = current_setting('app.tenant_id', true));
