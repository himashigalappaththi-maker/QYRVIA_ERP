-- QYRVIA Architecture Hardening (Phase 5.5) - Reserved permission codes
-- for every future module. Seeding now means:
--   * RBAC routes can reference these codes immediately.
--   * No future migration has to ALTER seeded role bundles.
--   * The Setup Wizard can render module-toggles against a stable list.

INSERT INTO permissions (code, description) VALUES
  -- ---- Night Audit / Day End -----------------------------------------
  ('night_audit.read',     'View night audit runs'),
  ('night_audit.run',      'Trigger manual night audit'),
  ('night_audit.config',   'Configure night audit schedule'),

  -- ---- Folio ----------------------------------------------------------
  ('folio.read',           'Read folios + lines'),
  ('folio.open',           'Open a folio'),
  ('folio.post',           'Post a charge / payment'),
  ('folio.close',          'Close / settle a folio'),
  ('folio.void',           'Void a folio or line'),

  -- ---- Housekeeping ---------------------------------------------------
  ('housekeeping.read',    'Read housekeeping tasks'),
  ('housekeeping.assign',  'Create / assign housekeeping tasks'),
  ('housekeeping.complete','Mark housekeeping tasks complete / verified'),

  -- ---- Travel Commerce -----------------------------------------------
  ('contract.read',        'Read contracts'),
  ('contract.write',       'Create / update contracts + rates'),
  ('allocation.read',      'Read allocations'),
  ('allocation.write',     'Create / update / release allocations'),
  ('reservation.group.write','Manage group + tour-series reservations'),
  ('proforma.read',        'Read proforma invoices'),
  ('proforma.write',       'Create / issue / cancel proforma invoices'),

  -- ---- Channel Manager ------------------------------------------------
  ('channel.mapping.read', 'Read channel <-> PMS mappings'),
  ('channel.mapping.write','Create / update channel mappings'),
  ('channel.sync.run',     'Trigger channel inventory / rate sync'),
  ('channel.sync.read',    'Read channel sync history'),

  -- ---- Revenue Management --------------------------------------------
  ('revenue.snapshot.read','Read revenue snapshots'),
  ('revenue.snapshot.write','Write actual / forecast revenue snapshots'),
  ('revenue.recommend.read','Read AI pricing recommendations'),

  -- ---- Reputation -----------------------------------------------------
  ('review.read',          'Read reviews'),
  ('review.reply',         'Reply to a review (manual or AI)'),
  ('review.import',        'Trigger review import from a channel'),

  -- ---- Guest Experience ----------------------------------------------
  ('guest_service.read',   'Read guest service requests'),
  ('guest_service.write',  'Create / update guest service requests'),
  ('reg_card.read',        'Read digital registration cards'),
  ('reg_card.sign',        'Capture signature for digital registration card'),

  -- ---- Mobile Access Control -----------------------------------------
  ('access.key.issue',     'Issue NFC/BLE/QR access key'),
  ('access.key.revoke',    'Revoke an access key'),
  ('access.key.read',      'Read access keys'),
  ('access.log.read',      'Read access logs'),

  -- ---- AI Platform ----------------------------------------------------
  ('ai.conversation.read', 'Read AI conversations + messages'),
  ('ai.copilot.use',       'Use the AI Copilot'),
  ('ai.whatsapp.config',   'Configure WhatsApp Booking Agent'),
  ('ai.concierge.config',  'Configure AI Concierge'),
  ('ai.revenue.use',       'Use AI Revenue Assistant'),

  -- ---- Restaurant / POS ----------------------------------------------
  ('pos.outlet.write',     'Create / update outlets, tables, menus'),
  ('pos.order.read',       'Read POS orders'),
  ('pos.order.write',      'Create / update POS orders'),
  ('pos.order.charge_room','Charge POS order to a guest folio'),

  -- ---- CRM ------------------------------------------------------------
  ('crm.read',             'Read CRM interactions'),
  ('crm.write',            'Create / update CRM interactions'),

  -- ---- Loyalty --------------------------------------------------------
  ('loyalty.account.read', 'Read loyalty accounts'),
  ('loyalty.account.write','Create / update loyalty accounts'),
  ('loyalty.tx.write',     'Post loyalty transactions'),

  -- ---- HR / Payroll ---------------------------------------------------
  ('hr.employee.read',     'Read HR employees'),
  ('hr.employee.write',    'Create / update HR employees'),
  ('payroll.read',         'Read payroll periods'),
  ('payroll.run',          'Run payroll for a period'),

  -- ---- Finance --------------------------------------------------------
  ('finance.ledger.read',  'Read ledger accounts + entries'),
  ('finance.ledger.write', 'Post journal entries'),

  -- ---- Procurement ----------------------------------------------------
  ('procurement.po.read',  'Read purchase orders'),
  ('procurement.po.write', 'Create / update purchase orders'),
  ('procurement.po.approve','Approve a purchase order'),

  -- ---- Inventory ------------------------------------------------------
  ('inventory.item.read',  'Read inventory items + stock levels'),
  ('inventory.item.write', 'Create / update inventory items'),
  ('inventory.stock.adjust','Adjust stock levels'),

  -- ---- Fixed Assets ---------------------------------------------------
  ('asset.read',           'Read fixed assets'),
  ('asset.write',           'Create / update fixed assets'),

  -- ---- Gate Pass / Security ------------------------------------------
  ('gatepass.read',        'Read gate passes'),
  ('gatepass.write',       'Issue / close gate passes'),

  -- ---- BI / Analytics -------------------------------------------------
  ('bi.dashboard.read',    'View BI dashboards'),
  ('bi.dataset.read',      'Query BI datasets')

ON CONFLICT (code) DO NOTHING;

-- corporate_admin + property_admin get every reserved permission.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code IN ('corporate_admin','property_admin')
   AND p.code IN (
     SELECT code FROM permissions
      WHERE code NOT LIKE 'pms.%' AND code NOT LIKE 'auth.%' AND code NOT LIKE 'settings.%'
        AND code NOT LIKE 'connector.%' AND code NOT LIKE 'webhook.%'
        AND code NOT LIKE 'job.%' AND code NOT LIKE 'notification.%'
        AND code NOT LIKE 'file.%'
   )
ON CONFLICT DO NOTHING;

-- Front Office Manager gets folio + housekeeping + guest_service +
-- reg_card + access_key issuing.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r CROSS JOIN permissions p
 WHERE r.code = 'front_office_manager'
   AND p.code IN (
     'folio.read','folio.open','folio.post','folio.close',
     'housekeeping.read','housekeeping.assign',
     'guest_service.read','guest_service.write',
     'reg_card.read','reg_card.sign',
     'access.key.issue','access.key.revoke','access.key.read',
     'night_audit.read'
   )
ON CONFLICT DO NOTHING;

-- ===========================================================================
-- Reserved settings categories (so the Setup Wizard knows their existence).
-- We only insert a category row + a single 'enabled' default per category;
-- detailed keys land with each module phase.
-- ===========================================================================
DO $$
DECLARE
  category TEXT;
BEGIN
  FOR category IN
    SELECT unnest(ARRAY[
      'night_audit','folio','housekeeping','travel_commerce',
      'channel_manager','revenue_management','reputation',
      'mobile_access','guest_experience','ai','restaurant_pos',
      'crm','loyalty','hr','payroll','finance','procurement',
      'inventory','fixed_assets','gate_pass','bi'
    ])
  LOOP
    -- settings table is keyed by (tenant_id, scope, scope_id, category, key);
    -- we skip seeding default rows here because tenant_id is unknown at
    -- migration time. The presence of the *category* is conventional - the
    -- module bootstrap inserts defaults at first-boot.
    NULL;
  END LOOP;
END$$;
