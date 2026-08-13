'use strict';

/**
 * auth.user.status.change - Phase 67A Workstream C.
 *
 * Administrator-initiated user DISABLE/TERMINATE. Runs through the command
 * bus, exactly like auth.user.create (permission `auth.user.disable` is
 * enforced by the command bus before the handler runs; super_admin
 * bypasses; every attempt AND its outcome, success or denial, is written to
 * audit_events automatically by the audit pipeline via the outcome's
 * error/detail codes - see audit/pipeline.js runWithAudit).
 *
 * TRANSACTION MODEL: this command is deliberately NOT registered with
 * `tenantScoped: true`. That flag routes through db/tenantUnitOfWork.js's
 * AsyncLocalStorage-based client (the pmsRepo/folioRepo convention), which
 * is a different system from the explicit-client `repo.withTenant(tenantId,
 * cb)` (db/client.js) that identityRepo/tokensRepo's user/role/token methods
 * require via `_requireClient`. Mixing the two would either throw
 * CLIENT_REQUIRED or silently run outside any tenant-bound transaction.
 * Instead this handler opens ONE identityRepo.withTenant(...) transaction
 * itself and performs every read/write inside it, atomically - the same
 * approach routes/auth.js's own /switch-property and /properties routes
 * already use directly against this exact repo object.
 *
 * Input:
 *   {
 *     target_user_id: uuid (required)
 *     status:         'DISABLED' | 'TERMINATED' (required, exact match only)
 *     reason:         string (optional, free text, stored in the audit
 *                     payload and the domain event - never a credential)
 *   }
 *
 * Denial codes (each becomes a distinct audit `command.denied`/`failed`
 * entry via the audit pipeline - see Section 9 of the Phase 67A brief):
 *   invalid_input / invalid_status / target_required
 *   target_not_found              - missing, soft-deleted, or (because
 *                                    findUserById runs inside a connection
 *                                    bound to ctx.tenantId) belonging to a
 *                                    different tenant
 *   self_status_change_denied      - an admin cannot disable/terminate
 *                                    their own account through this command
 *   unauthorized_property_target   - caller holds only property-scoped
 *                                    grants and the target's property is
 *                                    not one of them
 *   protected_system_role          - target holds super_admin or
 *                                    platform_admin; see NOTE below
 *   already_in_requested_status
 *
 * NOTE ON "FINAL ACTIVE SUPER ADMIN" PROTECTION (brief Section 6.2):
 *   This command denies ANY status change targeting a super_admin or
 *   platform_admin account, unconditionally, regardless of caller identity.
 *   This is a deliberately conservative, fail-closed implementation of the
 *   brief's own explicit escape hatch: "If the current architecture has no
 *   safe method to determine the final active Super Admin, deny that
 *   operation fail-closed and document it." Determining "is this the last
 *   active Super Admin" would require a query spanning every tenant, but
 *   every existing repo method in this codebase is tenant-scoped through
 *   FORCE ROW LEVEL SECURITY (a normal `withTenant(ctx.tenantId, ...)`
 *   connection cannot see rows belonging to a different tenant_id even for
 *   role/status counting) - so there is no safe, RLS-respecting way to
 *   perform that count today. Blocking ALL super_admin/platform_admin
 *   targets trivially satisfies both halves of Section 6.2 (customer admins
 *   can never touch a platform account, and no Super Admin - last one or
 *   not - can ever be disabled through this command) without inventing a
 *   new RLS-bypass mechanism, which is explicitly prohibited elsewhere in
 *   this same brief. Managing platform-tier accounts is left to a dedicated
 *   platform-admin-hierarchy flow, not this customer-facing command.
 */

const { makeEvent } = require('../core/event');

const ALLOWED_STATUSES = new Set(['DISABLED', 'TERMINATED']);
const PROTECTED_ROLE_CODES = new Set(['super_admin', 'platform_admin']);

module.exports = {
  name: 'auth.user.status.change',
  aggregateType: 'user',
  permission: 'auth.user.disable',

  _repo: null,
  setRepo(repo) { this._repo = repo; },

  async handler(input, ctx) {
    const repo = module.exports._repo;
    if (!repo) return { ok: false, error: 'repo_not_wired' };
    if (!input || typeof input !== 'object') return { ok: false, error: 'invalid_input' };

    const target_user_id = input.target_user_id;
    const status          = input.status;
    const reason           = input.reason ? String(input.reason).slice(0, 500) : null;

    if (!target_user_id) return { ok: false, error: 'target_required' };
    if (!status || !ALLOWED_STATUSES.has(String(status))) {
      return { ok: false, error: 'invalid_status', detail: 'status must be exactly DISABLED or TERMINATED' };
    }
    if (String(target_user_id) === String(ctx.actorId)) {
      return { ok: false, error: 'self_status_change_denied' };
    }
    if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
    if (typeof repo.withTenant !== 'function') return { ok: false, error: 'repo_not_wired' };

    let outcome;
    await repo.withTenant(ctx.tenantId, async (client) => {
      // Tenant-scoped by construction: a row belonging to a different
      // tenant is invisible on this connection, not merely filtered.
      const target = await repo.findUserById(target_user_id, client);
      if (!target) { outcome = { ok: false, error: 'target_not_found' }; return; }

      // Property-scoped administrators must not alter users outside their
      // authorized property membership scope (brief 6.1). A caller holding
      // ANY tenant-wide (property_id IS NULL) role grant is authorized for
      // every property in the tenant.
      let callerIsTenantWide = true;
      if (typeof repo.findRolesForUser === 'function') {
        const callerRoles = await repo.findRolesForUser(ctx.actorId, client);
        callerIsTenantWide = callerRoles.some((r) => r.property_id === null);
      }
      if (!callerIsTenantWide && target.primary_property_id
          && target.primary_property_id !== ctx.propertyId) {
        outcome = { ok: false, error: 'unauthorized_property_target' };
        return;
      }

      // System-role protection (brief 6.2) - see the NOTE above the module doc.
      if (typeof repo.findRolesForUser === 'function') {
        const targetRoles = await repo.findRolesForUser(target_user_id, client);
        if (targetRoles.some((r) => PROTECTED_ROLE_CODES.has(r.code))) {
          outcome = { ok: false, error: 'protected_system_role',
                      detail: 'super_admin and platform_admin accounts cannot be altered through this command' };
          return;
        }
      }

      if (target.status === status) {
        outcome = { ok: false, error: 'already_in_requested_status' };
        return;
      }

      const previousStatus = target.status;

      // Phase 67A-003: tenantId is passed explicitly as a second scoping
      // predicate (belt-and-suspenders alongside the withTenant/FORCE RLS
      // binding) — see db/repos.js's updateUserStatus doc comment.
      await repo.updateUserStatus(target_user_id, status, ctx.tenantId, client);

      // Session invalidation (brief 6.4): revoke every active refresh token
      // for the target, in the SAME transaction as the status write, so the
      // two can never diverge. tokens.js's rotation path (_rotateWithRLS)
      // already treats any revoked/rotated token presented for rotation as
      // reuse and rejects it - so this single call also satisfies "prevent
      // new refresh-token rotation" with no changes needed to the
      // token-rotation code itself. "Prevent new login" is already
      // satisfied unmodified: identity.js's login checks (repos.js-backed)
      // already reject DISABLED/TERMINATED status before issuing any token.
      await repo.revokeAllRefreshTokensForUser(target_user_id, client);

      outcome = {
        ok: true,
        result: { id: target_user_id, previous_status: previousStatus, status },
        entityType: 'user',
        entityId: target_user_id,
        events: [
          makeEvent({
            type:          'user.status_changed',
            aggregateType: 'user',
            aggregateId:   target_user_id,
            payload: {
              target_user_id,
              previous_status: previousStatus,
              new_status:       status,
              actor_id:         ctx.actorId,
              tenant_id:        ctx.tenantId,
              property_id:      ctx.propertyId || null,
              reason,
              refresh_tokens_revoked: true
            },
            ctx
          })
        ]
      };
    });

    return outcome || { ok: false, error: 'handler_incomplete' };
  }
};
