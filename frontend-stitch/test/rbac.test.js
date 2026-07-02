import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, visibleNav, canAccessRoute, matchPerm } from '../src/utils/rbac.js';
import { navItems } from '../src/app/routes.js';

test('matchPerm: exact, wildcard, star', () => {
  assert.equal(matchPerm('invoice.read', 'invoice.read'), true);
  assert.equal(matchPerm('pms.*', 'pms.reservation.read'), true);
  assert.equal(matchPerm('pms.*', 'pms'), true);
  assert.equal(matchPerm('*', 'anything.at.all'), true);
  assert.equal(matchPerm('invoice.read', 'invoice.void'), false);
});

test('can(): real permission array is authoritative + wildcard + deny-by-default', () => {
  assert.equal(can({ permissions: ['pms.reservation.read'] }, 'pms.reservation.read'), true);
  assert.equal(can({ permissions: ['folio.read', 'folio.post'] }, 'folio.post'), true);
  assert.equal(can({ permissions: ['housekeeping.*'] }, 'housekeeping.assign'), true);
  assert.equal(can({ permissions: ['invoice.read'] }, 'invoice.void'), false);
  assert.equal(can({ permissions: [] }, 'pms.reservation.read'), false);
  assert.equal(can({}, 'pms.reservation.read'), false);
  assert.equal(can({ permissions: ['x'] }, null), true);     // public/null permission
});

test('can(): super roles bypass (mirrors backend super_admin / *_admin)', () => {
  assert.equal(can({ roles: ['super_admin'] }, 'anything.at.all'), true);
  assert.equal(can({ roles: ['corporate_admin'] }, 'cost_center.write'), true);
  assert.equal(can({ roles: ['property_admin'] }, 'invoice.void'), true);
});

test('can(): role fallback when no permissions array', () => {
  assert.equal(can({ roles: ['front_office_manager'] }, 'pms.reservation.read'), true);
  assert.equal(can({ roles: ['housekeeping'] }, 'housekeeping.complete'), true);
  assert.equal(can({ roles: ['housekeeping'] }, 'invoice.void'), false);
});

test('visibleNav hides unauthorized sections; dashboard always visible', () => {
  const hk = visibleNav(navItems(), { permissions: ['housekeeping.read', 'pms.room.read'] }).map((r) => r.id);
  assert.ok(hk.includes('dashboard'));           // null permission -> always visible
  assert.ok(hk.includes('housekeeping'));
  assert.ok(!hk.includes('billing'));
  assert.ok(!hk.includes('admin'));

  const admin = visibleNav(navItems(), { roles: ['super_admin'] }).map((r) => r.id);
  assert.ok(admin.includes('admin') && admin.includes('billing') && admin.includes('revenue') && admin.includes('reservations'));
});

test('canAccessRoute: public ok, permissioned gated', () => {
  assert.equal(canAccessRoute({ public: true }, null), true);
  assert.equal(canAccessRoute({ permission: 'revenue.snapshot.read' }, { permissions: ['revenue.snapshot.read'] }), true);
  assert.equal(canAccessRoute({ permission: 'revenue.snapshot.read' }, { permissions: ['housekeeping.read'] }), false);
});
