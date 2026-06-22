import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, visibleNav, canAccessRoute } from '../src/utils/rbac.js';
import { navItems } from '../src/app/routes.js';

test('role permissions + wildcard + deny-by-default', () => {
  assert.equal(can({ roles: ['FRONT_DESK'] }, 'reservation.read'), true);
  assert.equal(can({ roles: ['FRONT_DESK'] }, 'billing.read'), false);
  assert.equal(can({ roles: ['ADMIN'] }, 'billing.void'), true);
  assert.equal(can({ roles: [] }, 'reservation.read'), false);
  assert.equal(can({ roles: ['ACCOUNTING'] }, 'billing.post'), true);
});

test('visibleNav hides unauthorized sections (UX), public always shown', () => {
  const hk = visibleNav(navItems(), { roles: ['HOUSEKEEPING'] }).map((r) => r.id);
  assert.ok(hk.includes('dashboard'));        // null-permission item always visible
  assert.ok(hk.includes('housekeeping'));
  assert.ok(!hk.includes('billing'));
  assert.ok(!hk.includes('admin'));
  const admin = visibleNav(navItems(), { roles: ['ADMIN'] }).map((r) => r.id);
  assert.ok(admin.includes('admin') && admin.includes('billing') && admin.includes('revenue'));
});

test('canAccessRoute: public ok, permissioned gated', () => {
  assert.equal(canAccessRoute({ public: true }, null), true);
  assert.equal(canAccessRoute({ permission: 'revenue.read' }, { roles: ['REVENUE_MANAGER'] }), true);
  assert.equal(canAccessRoute({ permission: 'revenue.read' }, { roles: ['HOUSEKEEPING'] }), false);
});
