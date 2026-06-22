-- QYRVIA Architecture Hardening (Phase 5.5) - AI Platform + Restaurant /
-- POS foundations.
--
-- WHY: AI Copilot, WhatsApp Booking Agent and AI Concierge are
--      conversation-shaped. POS / Restaurant ordering attaches to folio
--      via `folio_lines.source_module='POS'` (see migration 0023). The
--      tables below shape both persistence stacks.

-- ============================================================================
-- AI Conversations
-- ============================================================================
CREATE TYPE ai_channel AS ENUM (
  'COPILOT','WHATSAPP','CONCIERGE','REVENUE','ANALYTICS','EMAIL','SMS','OTHER'
);

CREATE TYPE ai_message_role AS ENUM ('user','assistant','system','tool');

CREATE TABLE ai_conversations (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  property_id     UUID         REFERENCES properties(id) ON DELETE SET NULL,
  channel         ai_channel   NOT NULL,
  user_id         UUID,                                       -- internal user, when staff-facing
  guest_id        UUID         REFERENCES guests(id) ON DELETE SET NULL,
  reservation_id  UUID         REFERENCES reservations(id) ON DELETE SET NULL,
  topic           VARCHAR(200),
  model           VARCHAR(80),                                -- 'claude-opus-4-7' etc
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  message_count   INTEGER      NOT NULL DEFAULT 0,
  token_in        INTEGER      NOT NULL DEFAULT 0,
  token_out       INTEGER      NOT NULL DEFAULT 0,
  cost_estimate   NUMERIC(14,4) NOT NULL DEFAULT 0,
  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_ai_conv_property_started ON ai_conversations(property_id, started_at DESC);
CREATE INDEX idx_ai_conv_guest ON ai_conversations(guest_id);
ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_conversations FORCE  ROW LEVEL SECURITY;
CREATE POLICY ai_conv_by_app ON ai_conversations
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TABLE ai_messages (
  id               UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID            NOT NULL REFERENCES tenants(id),
  conversation_id  UUID            NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role             ai_message_role NOT NULL,
  content          TEXT            NOT NULL,                  -- redacted of PII when archived
  tool_name        VARCHAR(80),
  token_in         INTEGER         NOT NULL DEFAULT 0,
  token_out        INTEGER         NOT NULL DEFAULT 0,
  occurred_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
  payload          JSONB           NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_ai_msg_conv ON ai_messages(conversation_id, occurred_at);
ALTER TABLE ai_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_messages FORCE  ROW LEVEL SECURITY;
CREATE POLICY ai_msg_by_app ON ai_messages
  USING (tenant_id::text = current_setting('app.tenant_id', true));

-- ============================================================================
-- Restaurant / POS
-- ============================================================================
CREATE TABLE restaurant_outlets (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  property_id  UUID         NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  code         VARCHAR(40)  NOT NULL,
  name         VARCHAR(200) NOT NULL,
  kind         VARCHAR(40)  NOT NULL,                        -- 'RESTAURANT','BAR','POOL','ROOM_SERVICE','SPA','OTHER'
  active       BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (property_id, code)
);
ALTER TABLE restaurant_outlets ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_outlets FORCE  ROW LEVEL SECURITY;
CREATE POLICY r_outlets_by_app ON restaurant_outlets
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TABLE restaurant_tables (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id),
  outlet_id   UUID         NOT NULL REFERENCES restaurant_outlets(id) ON DELETE CASCADE,
  number      VARCHAR(20)  NOT NULL,
  seats       INTEGER      NOT NULL DEFAULT 4,
  status      VARCHAR(20)  NOT NULL DEFAULT 'AVAILABLE',
  UNIQUE (outlet_id, number)
);
ALTER TABLE restaurant_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_tables FORCE  ROW LEVEL SECURITY;
CREATE POLICY r_tables_by_app ON restaurant_tables
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TABLE restaurant_menu_items (
  id            UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID            NOT NULL REFERENCES tenants(id),
  outlet_id     UUID            NOT NULL REFERENCES restaurant_outlets(id) ON DELETE CASCADE,
  code          VARCHAR(40)     NOT NULL,
  name          VARCHAR(200)    NOT NULL,
  category      VARCHAR(80),
  price         NUMERIC(12,2)   NOT NULL DEFAULT 0,
  tax_pct       NUMERIC(5,2)    NOT NULL DEFAULT 0,
  description   TEXT,
  active        BOOLEAN         NOT NULL DEFAULT true,
  payload       JSONB           NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (outlet_id, code)
);
ALTER TABLE restaurant_menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_menu_items FORCE  ROW LEVEL SECURITY;
CREATE POLICY r_menu_by_app ON restaurant_menu_items
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TYPE pos_order_status AS ENUM ('OPEN','SENT','SERVED','PAID','VOIDED');

CREATE TABLE pos_orders (
  id              UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID             NOT NULL REFERENCES tenants(id),
  property_id     UUID             NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  outlet_id       UUID             NOT NULL REFERENCES restaurant_outlets(id) ON DELETE RESTRICT,
  table_id        UUID             REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  reservation_id  UUID             REFERENCES reservations(id) ON DELETE SET NULL,
  guest_id        UUID             REFERENCES guests(id) ON DELETE SET NULL,
  order_number    VARCHAR(40)      NOT NULL,
  status          pos_order_status NOT NULL DEFAULT 'OPEN',
  charge_to_folio BOOLEAN          NOT NULL DEFAULT false,
  folio_id        UUID             REFERENCES folios(id) ON DELETE SET NULL,
  subtotal        NUMERIC(14,2)    NOT NULL DEFAULT 0,
  tax_total       NUMERIC(14,2)    NOT NULL DEFAULT 0,
  grand_total     NUMERIC(14,2)    NOT NULL DEFAULT 0,
  business_date   DATE,
  opened_at       TIMESTAMPTZ      NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  payload         JSONB            NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (property_id, order_number)
);
CREATE INDEX idx_pos_orders_property_status ON pos_orders(property_id, status);
CREATE INDEX idx_pos_orders_folio ON pos_orders(folio_id);
ALTER TABLE pos_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_orders FORCE  ROW LEVEL SECURITY;
CREATE POLICY pos_orders_by_app ON pos_orders
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TABLE pos_order_items (
  id             UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID            NOT NULL REFERENCES tenants(id),
  order_id       UUID            NOT NULL REFERENCES pos_orders(id) ON DELETE CASCADE,
  menu_item_id   UUID            REFERENCES restaurant_menu_items(id),
  description    VARCHAR(200),
  quantity       NUMERIC(10,2)   NOT NULL DEFAULT 1,
  unit_price     NUMERIC(12,2)   NOT NULL DEFAULT 0,
  tax_amount     NUMERIC(12,2)   NOT NULL DEFAULT 0,
  amount         NUMERIC(14,2)   NOT NULL DEFAULT 0,
  notes          TEXT
);
CREATE INDEX idx_pos_items_order ON pos_order_items(order_id);
ALTER TABLE pos_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_order_items FORCE  ROW LEVEL SECURITY;
CREATE POLICY pos_items_by_app ON pos_order_items
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TYPE kot_status AS ENUM ('NEW','PREPARING','READY','SERVED','VOIDED');

CREATE TABLE kot_tickets (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID         NOT NULL REFERENCES tenants(id),
  order_id       UUID         NOT NULL REFERENCES pos_orders(id) ON DELETE CASCADE,
  station        VARCHAR(40),     -- 'KITCHEN','BAR','PASTRY'
  status         kot_status   NOT NULL DEFAULT 'NEW',
  sent_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ready_at       TIMESTAMPTZ,
  served_at      TIMESTAMPTZ,
  payload        JSONB        NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_kot_order ON kot_tickets(order_id);
ALTER TABLE kot_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE kot_tickets FORCE  ROW LEVEL SECURITY;
CREATE POLICY kot_by_app ON kot_tickets
  USING (tenant_id::text = current_setting('app.tenant_id', true));
