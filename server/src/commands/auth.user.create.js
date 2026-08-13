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
 *     email:       string (optional, RFC pattern; normalized to
 *                  trim().toLowerCase() before validation, duplicate
 *                  detection and storage - see Phase 67A note below)
 *     password:    string (required, min 6)
 *     full_name:   string (required, 2..200)
 *     primary_property_id: uuid (optional; verified against ctx.tenantId
 *                  and the caller's own property access - Phase 67A)
 *     role_codes:  string[] of role codes to grant (default: ['staff'])
 *   }
 *
 * Phase 67A Workstream E — email normalization + primary_property_id
 * validation:
 *   - `normalized_email = trim(lower(email))` is computed ONCE, immediately
 *     after destructuring input, and used consistently for syntax
 *     validation, the INSERT, and the audit/domain-event payload. The
 *     global `uq_users_email_global` unique index on `lower(email)`
 *     (migration 0071) remains the final backstop regardless of this
 *     application-layer normalization.
 *   - When primary_property_id is supplied, it is verified - not trusted -
 *     before the user is ever inserted: the property must (a) exist,
 *     (b) belong to ctx.tenantId (the caller's own, server-derived tenant
 *     - never a client-supplied tenant id), and (c) be a property the
 *     calling administrator can themselves access (reuses
 *     repo.canAccessProperty, the same check identityContext.js's
 *     X-Property-Id override path already uses). Any failure REJECTS the
 *     whole command with a specific error code - it never silently drops
 *     or substitutes a different property for an invalid one.
 *   - This phase does not change which roles may call this command at all
 *     (Property Admin is not granted auth.user.create here - that is a
 *     later, separate onboarding-phase role-design decision per the brief).
 *
 * Phase 67A-003 Workstream E — single tenant-scoped atomic transaction
 * ──────────────────────────────────────────────────────────────────
 * Every mutation this command performs - the duplicate-username check,
 * property validation, the user INSERT, and every role/membership grant -
 * now runs inside ONE repo.withTenant(ctx.tenantId, ...) transaction,
 * using the SAME client throughout. Previously insertUser /
 * insertUserRoleByCode (and the duplicate-username lookup) used bare
 * repo pool.query() calls outside any transaction - under this schema's
 * FORCE ROW LEVEL SECURITY, a bare pool connection carries no
 * app.tenant_id session GUC, so those writes were either silently
 * invisible (SELECT) or would fail the policy's WITH CHECK clause
 * (INSERT) in production (db/repos.js's own comment on these methods:
 * "Legacy pre-62A pool-based lookups - broken under FORCE RLS; kept for
 * backward compat"). Beyond the RLS defect, running insertUser and
 * insertUserRoleByCode as separate, independently-committed statements
 * meant a role-assignment failure after a successful user insert left an
 * ORPHANED user with no role at all - this is now impossible: any failure
 * at any step rolls back the entire transaction, so a user row is never
 * left half-created.
 *
 * insertUser/insertUserRoleByCode/findUserByTenantUsernameById in
 * db/repos.js were extended with an OPTIONAL trailing client parameter
 * (falling back to the bare pool when omitted, matching the exact pattern
 * db/repos.js already uses for listAccessibleProperties/
 * canAccessProperty) - every OTHER existing caller of these three methods
 * (services/invitation.js's acceptInvitation, services/
 * platformBootstrap.js) calls them with their original argument count and
 * is completely unaffected.
 *
 * NOTE ON AUDIT PERSISTENCE: this command's own domain event (in the
 * `events` array returned below) and the command bus's own automatic
 * command.attempted/command.succeeded/command.failed audit trail (see
 * core/audit/pipeline.js's runWithAudit, which wraps EVERY command
 * dispatch in this codebase) are written by the command bus, not by this
 * handler - exactly like every other command in the codebase, including
 * auth.user.status.change from the prior Phase 67A pass.
 * core/audit/pipeline.js and core/commandBus.js are both outside this
 * phase's permitted file scope, so their transaction boundary relative to
 * this handler's own withTenant block is an existing, codebase-wide
 * architectural characteristic, not something introduced or changed here.
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

    // Phase 67A: normalize once, use everywhere below. Never log the raw
    // (unnormalized) value or the password.
    const normalizedEmail = email ? String(email).trim().toLowerCase() : null;

    if (!username || !USERNAME_RE.test(String(username))) errors.push('username invalid');
    if (!password || String(password).length < 6)        errors.push('password too short');
    if (!full_name || String(full_name).length < 2)     errors.push('full_name required');
    if (normalizedEmail && !EMAIL_RE.test(normalizedEmail)) errors.push('email invalid');
    if (errors.length) return { ok: false, error: 'validation_failed', detail: errors.join('; ') };

    if (typeof repo.withTenant !== 'function') {
      return { ok: false, error: 'tenant_transaction_unavailable' };
    }

    // ----- role selection + escalation guard --------------------------
    // Pure input/ctx check - no DB access needed, so it is resolved before
    // ever opening the transaction below.
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

    // Password hashing is pure CPU work - done before opening the
    // transaction so the DB connection is not held open during it.
    const password_hash = await identity.hashPassword(password);

    // ----- Phase 67A-003: everything below runs in ONE tenant-scoped
    // transaction. Any failure at any step rolls back the whole thing -
    // there is no code path that can leave a partially-created user. -----
    let outcome;
    await repo.withTenant(ctx.tenantId, async (client) => {
      // ----- duplicate check ------------------------------------------
      if (typeof repo.findUserByTenantUsernameById === 'function') {
        const existing = await repo.findUserByTenantUsernameById(ctx.tenantId, username, client);
        if (existing) { outcome = { ok: false, error: 'username_taken' }; return; }
      }

      // ----- primary_property_id validation (Phase 67A) ----------------
      // Not trusted from the request body: must exist, belong to the
      // caller's own tenant, and be a property the calling administrator
      // can themselves access.
      if (primary_property_id) {
        if (typeof repo.findPropertyForAuth !== 'function') {
          outcome = { ok: false, error: 'property_validation_unavailable' };
          return;
        }
        const property = await repo.findPropertyForAuth(primary_property_id, client);
        if (!property) { outcome = { ok: false, error: 'property_not_found' }; return; }
        if (property.tenant_id !== ctx.tenantId) {
          outcome = { ok: false, error: 'cross_tenant_property_assignment' };
          return;
        }
        if (typeof repo.canAccessProperty === 'function') {
          const callerAuthorized = await repo.canAccessProperty(ctx.actorId, primary_property_id, client);
          if (!callerAuthorized) {
            outcome = { ok: false, error: 'unauthorized_property_assignment' };
            return;
          }
        }
      }

      // ----- insert user -------------------------------------------------
      const row = await repo.insertUser({
        tenant_id:           ctx.tenantId,
        username:            username,
        email:               normalizedEmail,
        password_hash:       password_hash,
        full_name:           full_name,
        primary_property_id: primary_property_id || null,
        status:              identity.USER_STATUS.ACTIVE
      }, client);

      // ----- role + membership grants (property_id on the grant IS the
      // membership record in this schema - see findRolesForUser /
      // listAccessibleProperties / canAccessProperty, all of which key off
      // user_roles.property_id; there is no separate membership table) ---
      for (const code of codes) {
        await repo.insertUserRoleByCode({
          user_id:    row.id,
          role_code:  code,
          tenant_id:  ctx.tenantId,
          property_id: primary_property_id || null,
          granted_by: ctx.actorId
        }, client);
      }

      outcome = {
        ok: true,
        result: { id: row.id, username: row.username },
        events: [
          makeEvent({
            type:          'user.created',
            aggregateType: 'user',
            aggregateId:   row.id,
            payload:       { username, email: normalizedEmail, role_codes: codes, primary_property_id: primary_property_id || null },
            ctx
          })
        ]
      };
    });

    return outcome || { ok: false, error: 'handler_incomplete' };
  }
};
