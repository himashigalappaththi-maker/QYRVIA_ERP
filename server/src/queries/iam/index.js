'use strict';

/**
 * IAM read queries (Phase 21) - SAFE, read-only listings used by the admin UI.
 * No RBAC logic change: gated by the existing `auth.user.create` permission
 * (and the bus's super_admin bypass). Never returns secrets (repo selects
 * exclude password_hash).
 */

function makeIamQueries({ identityRepo }) {
  if (!identityRepo) throw new Error('makeIamQueries: identityRepo required');
  const list = [];

  list.push({
    name: 'iam.users.list', resourceType: 'user', permission: 'auth.user.create',
    async handler(input, ctx) {
      if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
      if (typeof identityRepo.listUsers !== 'function') return { ok: true, data: [] };
      return { ok: true, data: await identityRepo.listUsers(ctx.tenantId) };
    }
  });

  list.push({
    name: 'iam.roles.list', resourceType: 'role', permission: 'auth.user.create',
    async handler(_input, _ctx) {
      if (typeof identityRepo.listRoles !== 'function') return { ok: true, data: [] };
      return { ok: true, data: await identityRepo.listRoles() };
    }
  });

  return list;
}

module.exports = { makeIamQueries };
