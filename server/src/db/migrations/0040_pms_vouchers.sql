-- QYRVIA Phase 7 / C6 - Voucher workflow.
--
-- WHY: When a Travel Agent / DMC / Tour Operator books on behalf of a
-- guest, they issue the guest a voucher (a numbered document). At check-in
-- the hotel must validate the voucher AND attribute the room revenue to
-- the partner for later settlement. Without this entity, TA / DMC flows
-- depend on undocumented spreadsheet steps.

CREATE TYPE voucher_status AS ENUM ('ISSUED','REDEEMED','EXPIRED','CANCELLED');

CREATE TABLE vouchers (
  id                       UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID            NOT NULL REFERENCES tenants(id),
  property_id              UUID            NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  voucher_number           VARCHAR(40)     NOT NULL,
  agent_guest_id           UUID            REFERENCES guests(id),
  contract_id              UUID            REFERENCES contracts(id),
  guest_name               VARCHAR(200),
  arrival_date             DATE            NOT NULL,
  departure_date           DATE            NOT NULL,
  room_type_id             UUID            REFERENCES room_types(id),
  status                   voucher_status  NOT NULL DEFAULT 'ISSUED',
  amount                   NUMERIC(14,2)   NOT NULL DEFAULT 0,
  currency                 CHAR(3)         NOT NULL DEFAULT 'LKR',
  issued_at                TIMESTAMPTZ     NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ,
  redeemed_at              TIMESTAMPTZ,
  redeemed_reservation_id  UUID            REFERENCES reservations(id) ON DELETE SET NULL,
  cancelled_at             TIMESTAMPTZ,
  cancellation_reason      TEXT,
  payload                  JSONB           NOT NULL DEFAULT '{}'::jsonb,
  created_by               UUID,
  CHECK (departure_date > arrival_date)
);
CREATE UNIQUE INDEX ux_vouchers_number ON vouchers(property_id, voucher_number);
CREATE INDEX idx_vouchers_agent ON vouchers(agent_guest_id);
CREATE INDEX idx_vouchers_status ON vouchers(tenant_id, status);

ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vouchers FORCE  ROW LEVEL SECURITY;
CREATE POLICY vouchers_by_app ON vouchers
  USING (tenant_id::text = current_setting('app.tenant_id', true));

INSERT INTO permissions (code, description) VALUES
  ('voucher.read',   'Read vouchers'),
  ('voucher.write',  'Issue or cancel vouchers'),
  ('voucher.redeem', 'Redeem a voucher at check-in')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('corporate_admin','property_admin','front_office_manager')
  AND p.code IN ('voucher.read','voucher.write','voucher.redeem')
ON CONFLICT DO NOTHING;
