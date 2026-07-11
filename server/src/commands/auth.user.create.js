'use strict';

/**
 * auth.user.create - admin-initiated user creation.
 *
 * Runs through the command bus (audit pipeline writes attempt + outcome).
 * Permission `auth.user.create` is enforced by the command bus before
 * the handler runs - super_admin bypasses (see commandBus + identity.hasPermission).
 *
 * Input:
 *   {
 *     username:    string (required, 3..64, [A-Za-z0-9._-])
 *     email:       string (optional, RFC pattern)
 *     password:    string (required, min 6)
 *     full_name:   string (required, 2..200)
 *     primary_property_id: uuid (optional)
 *     role_codes:  string[] of role codes to grant (default: ['staff'])
 *   }
 */

const identity = require('../services/identity');
const { makeEvent } = require('../core/event');

const USERNAME_RE = /^[A-Za-z0-9._-]{3,64}$/;
const EMAIL_RE    = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

module.exports = {
  name: 'auth.user.create',
  aggregateType: 'user',
  permission: 'auth.user.create',

  /**
   * `repo` is injected by commandBus.dispatch via a registry hook; alternatively
   * the route layer can pass it. For Phase 2 we expose `setRepo(repo)` to wire it.
   */
  _repo: null,
  setRepo(repo) { this._repo = repo; },

  async handler(input, ctx) {
    const repo = module.exports._repo;
    if (!repo) return { ok: false, error: 'repo_not_wired' };

    // ----- validate ---------------------------------------------------
    const errors = [];
    if (!input || typeof input !== 'object') return { ok: false, error: 'invalid_input' };
    const { username, email, password, full_name, primary_property_id, role_codes } = input;
    if (!username || !USERNAME_RE.test(String(username))) errors.push('username invalid');
    if (!password || String(password).length < 6)        errors.push('password too short');
    if (!full_name || String(full_name).length < 2)     errors.push('full_name required');
    if (email && !EMAIL_RE.test(String(email)))         errors.push('email invalid');
    if (errors.length) return { ok: false, error: 'validation_failed', detail: errors.join('; ') };

    // ----- duplicate check -------------------------------------------
    if (typeof repo.findUserByTenantUsername === 'function') {
      const existing = await repo.findUserByTenantUsernameById(ctx.tenantId, username);
      if (existing) return { ok: false, error: 'username_taken' };
    }

    // ----- hash + insert ---------------------------------------------
    const password_hash = await identity.hashPassword(password);
    const row = await repo.insertUser({
      tenant_id:           ctx.tenantId,
      username:            username,
      email:               email || null,
      password_hash:       password_hash,
      full_name:           full_name,
      primary_property_id: primary_property_id || null,
      status:              identity.USER_STATUS.ACTIVE
    });

    // ----- role grants -----------------------------------------------
    const codes = Array.isArray(role_codes) && role_codes.length ? role_codes : ['staff'];

    // Role ceiling guard: SYSTEM-scoped roles may only be granted by a super_admin.
    // Prevents a corporate_admin (who holds auth.user.create) from escalating a new
    // user to super_admin or platform_admin. Update SYSTEM_ROLES when new system roles
    // are added via migration so the guard stays current.
    const SYSTEM_ROLES = new Set(['super_admin', 'platform_admin']);
    const callerIsSuperAdmin = Array.isArray(ctx.roleCodes) && ctx.roleCodes.includes('super_admin');
    if (!callerIsSuperAdmin) {
      const blocked = codes.filter((c) => SYSTEM_ROLES.has(c));
      if (blocked.length) {
        return { ok: false, error: 'role_escalation_denied',
                 detail: `Only super_admin may grant system-scoped roles: ${blocked.join(', ')}` };
      }
    }

    for (const code of codes) {
      await repo.insertUserRoleByCode({
        user_id:    row.id,
        role_code:  code,
        tenant_id:  ctx.tenantId,
        property_id: primary_property_id || null,
        granted_by: ctx.actorId
      });
    }

    return {
      ok: true,
      result: { id: row.id, username: row.username },
      events: [
        makeEvent({
          type:          'user.created',
          aggregateType: 'user',
          aggregateId:   row.id,
          payload:       { username, email, role_codes: codes, primary_property_id: primary_property_id || null },
          ctx
        })
      ]
    };
  }
};
