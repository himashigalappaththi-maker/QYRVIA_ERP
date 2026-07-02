'use strict';

/** Phase 24 B8-B2 - channel mapping management: versioning, history, audit, RLS. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildChannelMappingManagement } = require('../src/channel-manager/mapping');

function setup(onAudit) {
  return buildChannelMappingManagement({ mode: 'memory', onAudit });
}
const KEY = { tenant_id: 't1', property_id: 'p1', channel: 'BOOKING_COM', room_type_id: 'rt1' };

// ---- create + version 1 + history + audit ---------------------------------
test('create mapping: version 1, history CREATED, audit channel.mapping_created', () => {
  const audits = [];
  const { service } = setup((e) => audits.push(e));
  const r = service.upsertMapping(Object.assign({}, KEY, { ota_room_id: 'OTA-RT-1' }), { actor_id: 'u1' });
  assert.equal(r.ok, true);
  assert.equal(r.change_type, 'CREATED');
  assert.equal(r.mapping_version, 1);
  assert.equal(r.item.ota_room_id, 'OTA-RT-1');
  assert.equal(r.item.enabled, true);

  const hist = service.getHistory({ tenant_id: 't1', room_type_id: 'rt1' });
  assert.equal(hist.length, 1);
  assert.equal(hist[0].change_type, 'CREATED');
  assert.equal(hist[0].mapping_version, 1);
  assert.equal(hist[0].actor_id, 'u1');

  assert.equal(audits[0].type, 'channel.mapping_created');
  assert.equal(audits[0].mapping_version, 1);
});

// ---- update -> version 2 ---------------------------------------------------
test('update mapping: version 2, history UPDATED, partial merge preserved', () => {
  const audits = [];
  const { service } = setup((e) => audits.push(e));
  service.upsertMapping(Object.assign({}, KEY, { ota_room_id: 'OTA-RT-1', ota_rate_plan_id: 'OTA-RP-1' }));
  const r = service.upsertMapping(Object.assign({}, KEY, { ota_room_id: 'OTA-RT-1b' })); // partial update
  assert.equal(r.change_type, 'UPDATED');
  assert.equal(r.mapping_version, 2);
  assert.equal(r.item.ota_room_id, 'OTA-RT-1b');
  assert.equal(r.item.ota_rate_plan_id, 'OTA-RP-1', 'unspecified field preserved');

  const hist = service.getHistory({ tenant_id: 't1', room_type_id: 'rt1' });
  assert.equal(hist.length, 2);
  assert.equal(hist[1].change_type, 'UPDATED');
  assert.equal(audits.map((a) => a.type).join(','), 'channel.mapping_created,channel.mapping_updated');
});

// ---- disable / enable ------------------------------------------------------
test('disable then enable: versions advance; history DISABLED/ENABLED; audit', () => {
  const audits = [];
  const { service } = setup((e) => audits.push(e));
  service.upsertMapping(Object.assign({}, KEY, { ota_room_id: 'X' }));        // v1
  const d = service.setEnabled(KEY, false, { actor_id: 'u2' });               // v2
  assert.equal(d.change_type, 'DISABLED');
  assert.equal(d.item.enabled, false);
  assert.equal(d.mapping_version, 2);
  const e = service.setEnabled(KEY, true);                                    // v3
  assert.equal(e.change_type, 'ENABLED');
  assert.equal(e.item.enabled, true);
  assert.equal(e.mapping_version, 3);

  const hist = service.getHistory({ tenant_id: 't1', room_type_id: 'rt1' });
  assert.deepEqual(hist.map((h) => h.change_type), ['CREATED', 'DISABLED', 'ENABLED']);
  assert.deepEqual(audits.map((a) => a.type), ['channel.mapping_created', 'channel.mapping_disabled', 'channel.mapping_enabled']);
});

test('setEnabled on a missing mapping returns mapping_not_found', () => {
  const { service } = setup();
  const r = service.setEnabled(KEY, false);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'mapping_not_found');
});

// ---- rate plan + property mapping fields ----------------------------------
test('rate plan + property mapping fields persist', () => {
  const { service } = setup();
  const r = service.upsertMapping(Object.assign({}, KEY, { ota_room_id: 'R', ota_rate_plan_id: 'RP-9', ota_property_id: 'HOTEL-42' }));
  assert.equal(r.item.ota_rate_plan_id, 'RP-9');
  assert.equal(r.item.ota_property_id, 'HOTEL-42');
  assert.equal(service.getMapping('t1', 'p1', 'BOOKING_COM', 'rt1').ota_property_id, 'HOTEL-42');
});

// ---- listMappings + filter -------------------------------------------------
test('listMappings returns mappings filtered', () => {
  const { service } = setup();
  service.upsertMapping(Object.assign({}, KEY, { ota_room_id: 'A' }));
  service.upsertMapping({ tenant_id: 't1', property_id: 'p1', channel: 'AGODA', room_type_id: 'rt2', ota_room_id: 'B' });
  assert.equal(service.listMappings({ tenant_id: 't1' }).length, 2);
  assert.equal(service.listMappings({ channel: 'AGODA' }).length, 1);
});

// ---- RLS isolation ---------------------------------------------------------
test('RLS isolation: another tenant cannot read the mapping', () => {
  const { service } = setup();
  service.upsertMapping(Object.assign({}, KEY, { ota_room_id: 'A' }));
  assert.equal(service.getMapping('tOTHER', 'p1', 'BOOKING_COM', 'rt1'), null);
  assert.equal(service.getHistory({ tenant_id: 'tOTHER' }).length, 0);
});

// ---- no secret leakage in audit -------------------------------------------
test('audit events carry metadata only (no credentials_ref / secrets)', () => {
  const audits = [];
  const { service } = setup((e) => audits.push(e));
  service.upsertMapping(Object.assign({}, KEY, { ota_room_id: 'A', credentials_ref: 'booking-com:p1' }));
  service.setEnabled(KEY, false);
  for (const a of audits) {
    assert.equal(a.credentials_ref, undefined, 'audit must not include credentials_ref');
    assert.ok(!JSON.stringify(a).includes('booking-com:p1'));
  }
});

// ---- migration validity ----------------------------------------------------
test('migration 0048: history table + versioning columns + RLS', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/0048_channel_mapping_versioning.sql'), 'utf8');
  assert.ok(/ALTER TABLE channel_mapping_store[\s\S]*ADD COLUMN mapping_version/.test(sql));
  assert.ok(/ADD COLUMN ota_property_id/.test(sql));
  assert.ok(sql.includes('CREATE TABLE channel_mapping_history'));
  for (const col of ['mapping_version', 'change_type', 'changed_at', 'actor_id', 'tenant_id']) assert.ok(sql.includes(col));
  assert.ok(/change_type[\s\S]*CHECK \(change_type IN \('CREATED','UPDATED','DISABLED','ENABLED'\)\)/.test(sql));
  assert.ok(/ENABLE ROW LEVEL SECURITY/.test(sql) && /FORCE\s+ROW LEVEL SECURITY/.test(sql));
  assert.ok(/current_setting\('app\.tenant_id', true\)/.test(sql));
});
