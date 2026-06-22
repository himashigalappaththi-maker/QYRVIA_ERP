'use strict';

/**
 * Phase 5.5 - Architecture Readiness migration audit.
 *
 * These tests are static (read-only on the .sql files) and verify that the
 * mandatory hardening migrations exist, are sequenced correctly, declare
 * RLS on every new tenant-scoped table, and seed the reserved permission
 * codes downstream modules will rely on.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const MIG_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');
function listSql() { return fs.readdirSync(MIG_DIR).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort(); }
function read(f) { return fs.readFileSync(path.join(MIG_DIR, f), 'utf8'); }
const ALL = listSql().map(read).join('\n');

test('migrations 0022..0030 exist and form a contiguous sequence', () => {
  const files = listSql();
  for (let i = 22; i <= 30; i++) {
    const prefix = String(i).padStart(4, '0') + '_';
    assert.ok(files.some(f => f.startsWith(prefix)), 'missing migration ' + prefix + '*');
  }
});

test('Phase 7: migrations 0037..0041 exist and form a contiguous sequence', () => {
  const files = listSql();
  for (let i = 37; i <= 41; i++) {
    const prefix = String(i).padStart(4, '0') + '_';
    assert.ok(files.some(f => f.startsWith(prefix)), 'missing migration ' + prefix + '*');
  }
});

test('Phase 7 / C8: payment_allocations table exists with FK to folios + folio_lines', () => {
  assert.match(ALL, /CREATE TABLE payment_allocations[\s\S]*folio_id[\s\S]*REFERENCES folios[\s\S]*payment_line_id[\s\S]*REFERENCES folio_lines/i);
});

test('Phase 7 / C9: invoices table has counter + status enum + RLS', () => {
  assert.match(ALL, /CREATE TYPE invoice_status AS ENUM[\s\S]*'ISSUED'[\s\S]*'VOIDED'/i);
  assert.match(ALL, /CREATE TABLE invoices[\s\S]*folio_id[\s\S]*REFERENCES folios[\s\S]*invoice_number/i);
  assert.match(ALL, /CREATE TABLE invoice_counters/i);
  assert.match(ALL, /ALTER TABLE invoices ENABLE ROW LEVEL SECURITY/i);
});

test('Phase 7 / C6: vouchers table has agent_guest_id + status enum + RLS', () => {
  assert.match(ALL, /CREATE TYPE voucher_status AS ENUM[\s\S]*'REDEEMED'[\s\S]*'CANCELLED'/i);
  assert.match(ALL, /CREATE TABLE vouchers[\s\S]*agent_guest_id[\s\S]*REFERENCES guests/i);
  assert.match(ALL, /ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY/i);
});

test('Phase 7 / C7: allocation lifecycle indexes + allocation.release permission', () => {
  assert.match(ALL, /CREATE INDEX IF NOT EXISTS idx_allocations_property_status/i);
  assert.match(ALL, /'allocation\.release'/);
});

test('Phase 7: invoice + voucher permissions seeded', () => {
  ['invoice.read','invoice.write','invoice.void',
   'voucher.read','voucher.write','voucher.redeem',
   'folio.allocate.read'].forEach((p) => {
    const re = new RegExp("\\('" + p.replace(/\./g, '\\.') + "'");
    assert.ok(re.test(ALL), 'missing permission seed: ' + p);
  });
});

test('Phase 6 / C14: settings_schema migration exists with required columns', () => {
  const files = listSql();
  assert.ok(files.some(f => f === '0031_settings_catalog.sql'), 'missing 0031_settings_catalog.sql');
  assert.match(ALL, /CREATE TABLE settings_schema[\s\S]*value_type\s+VARCHAR\(20\)[\s\S]*CHECK[\s\S]*UNIQUE\s*\(\s*category\s*,\s*key\s*\)/i);
  assert.match(ALL, /'settings\.schema\.read'/);
});

test('tenants table is extended with company branding columns', () => {
  assert.match(ALL, /ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_name/i);
  assert.match(ALL, /ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_logo_url/i);
});

test('properties table is extended with brand + contact + timezone columns', () => {
  ['logo_url','address','phone','email','timezone'].forEach((c) => {
    const re = new RegExp('ALTER TABLE properties ADD COLUMN IF NOT EXISTS ' + c, 'i');
    assert.ok(re.test(ALL), 'properties.' + c + ' missing');
  });
});

test('reservation_status enum extended with CHECKED_IN / CHECKED_OUT / DEPARTED', () => {
  ['CHECKED_IN','CHECKED_OUT','DEPARTED'].forEach((v) => {
    const re = new RegExp("ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS '" + v + "'", 'i');
    assert.ok(re.test(ALL), 'reservation_status missing value ' + v);
  });
});

test('every reserved Phase 5.5 table has ENABLE + FORCE ROW LEVEL SECURITY', () => {
  const reservedTables = [
    'folios','folio_lines','housekeeping_tasks','folio_counters',
    'reservation_groups','reservation_series','contracts','contract_rates','allocations','proforma_invoices',
    'night_audit_runs',
    'channel_mappings','channel_inventory_sync_log','revenue_snapshots','reviews','reputation_scores',
    'guest_service_requests','digital_registration_cards','access_keys','access_logs',
    'ai_conversations','ai_messages','restaurant_outlets','restaurant_tables',
    'restaurant_menu_items','pos_orders','pos_order_items','kot_tickets',
    'crm_interactions','loyalty_accounts','loyalty_transactions','hr_employees',
    'payroll_periods','finance_ledger_accounts','finance_journal_entries',
    'procurement_purchase_orders','inventory_items','inventory_stock_levels',
    'fixed_assets','gate_passes'
  ];
  for (const t of reservedTables) {
    const enabled = new RegExp('ALTER\\s+TABLE\\s+' + t + '\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY', 'i').test(ALL);
    const forced  = new RegExp('ALTER\\s+TABLE\\s+' + t + '\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY', 'i').test(ALL);
    assert.ok(enabled, t + ' missing ENABLE ROW LEVEL SECURITY');
    assert.ok(forced,  t + ' missing FORCE ROW LEVEL SECURITY');
  }
});

test('reserved permission codes are seeded for every future module', () => {
  const reservedPerms = [
    'night_audit.read','night_audit.run',
    'folio.read','folio.open','folio.post','folio.close',
    'housekeeping.read','housekeeping.assign','housekeeping.complete',
    'contract.read','contract.write','allocation.read','allocation.write',
    'proforma.read','proforma.write','reservation.group.write',
    'channel.mapping.read','channel.mapping.write','channel.sync.run',
    'revenue.snapshot.read','revenue.snapshot.write','revenue.recommend.read',
    'review.read','review.reply','review.import',
    'guest_service.read','guest_service.write','reg_card.read','reg_card.sign',
    'access.key.issue','access.key.revoke','access.key.read','access.log.read',
    'ai.conversation.read','ai.copilot.use','ai.whatsapp.config','ai.concierge.config','ai.revenue.use',
    'pos.outlet.write','pos.order.read','pos.order.write','pos.order.charge_room',
    'crm.read','crm.write','loyalty.account.read','loyalty.account.write','loyalty.tx.write',
    'hr.employee.read','hr.employee.write','payroll.read','payroll.run',
    'finance.ledger.read','finance.ledger.write',
    'procurement.po.read','procurement.po.write','procurement.po.approve',
    'inventory.item.read','inventory.item.write','inventory.stock.adjust',
    'asset.read','asset.write','gatepass.read','gatepass.write',
    'bi.dashboard.read','bi.dataset.read'
  ];
  for (const p of reservedPerms) {
    const re = new RegExp("\\('" + p.replace(/\./g, '\\.') + "'", 'g');
    assert.ok(re.test(ALL), 'missing seeded permission code: ' + p);
  }
});

test('Night Audit run uniqueness: one row per property+business_date', () => {
  assert.match(ALL, /CREATE\s+UNIQUE\s+INDEX\s+ux_night_audit_property_busdate/i);
});

test('Folio table joins on reservation + property + tenant', () => {
  assert.match(ALL, /CREATE TABLE folios[\s\S]*reservation_id[\s\S]*REFERENCES reservations/i);
  assert.match(ALL, /CREATE TABLE folios[\s\S]*property_id[\s\S]*REFERENCES properties/i);
});

test('Folio lines carry business_date and source_module so finance can reconcile by audit day', () => {
  assert.match(ALL, /CREATE TABLE folio_lines[\s\S]*business_date\s+DATE\s+NOT NULL/i);
  assert.match(ALL, /CREATE TABLE folio_lines[\s\S]*source_module\s+VARCHAR/i);
});

test('Access keys carry vendor + valid_from < valid_to constraint', () => {
  assert.match(ALL, /CREATE TABLE access_keys[\s\S]*vendor[\s\S]*vendor_key_id/i);
  assert.match(ALL, /CHECK\s*\(valid_to\s*>\s*valid_from\)/i);
});

test('Reviews carry channel + rating + reply for AI response generation', () => {
  assert.match(ALL, /CREATE TABLE reviews[\s\S]*channel[\s\S]*rating[\s\S]*reply/i);
});

test('AI conversation table tracks token IO and cost for billing', () => {
  assert.match(ALL, /CREATE TABLE ai_conversations[\s\S]*token_in[\s\S]*token_out[\s\S]*cost_estimate/i);
});

test('Channel mappings cover the major OTAs by convention (connector_code is free-text)', () => {
  // We do not seed mappings here; we just verify the table accepts arbitrary connector_codes.
  assert.match(ALL, /CREATE TABLE channel_mappings[\s\S]*connector_code\s+VARCHAR/i);
});
