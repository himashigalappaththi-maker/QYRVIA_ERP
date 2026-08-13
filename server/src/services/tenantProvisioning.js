'use strict';

/**
 * buildTenantProvisioningService({ pool, invitationService })
 *
 * Creates a complete customer organisation atomically:
 *   1. tenant record
 *   2. first property
 *   3. hold-expiry sweep scheduled job (Phase 56)
 *   4. durable owner-invitation record + notification-outbox row
 *      (Phase 67A — see below)
 *   5. audit event
 * ALL FIVE in ONE transaction. COMMIT only after every step above succeeds;
 * any failure ROLLBACKs the whole thing — there is no code path that can
 * leave a tenant/property committed without its initial administrator
 * invitation.
 *
 * Phase 67A atomicity fix: previously the invitation was created via
 * invitationService.createInvitation(...) AFTER this function's own
 * transaction had already committed — a SEPARATE transaction opened by
 * invitationService itself (via withTenantFn). If that second transaction
 * failed, the tenant/property from the first transaction were already
 * durably committed, producing an orphan tenant with no administrator and
 * no way to complete onboarding. This function now instead calls
 * invitationService.createInvitationInTransaction({ ..., client }),
 * passing THIS function's own open transaction client directly, so the
 * invitation record and its notification-outbox row are written with the
 * exact same BEGIN/COMMIT as the tenant and property rows. Actual EMAIL
 * DELIVERY is not performed here or inside any transaction — it was
 * already, before this fix, a pure durable-outbox DB write (see
 * services/identityNotificationOutbox.js's enqueueIdentityInvitationNotification
 * — a 'pending' row insert, never a network call); a separate, pre-existing
 * worker (Phase 58 notification retry worker) delivers it after commit and
 * retries independently on delivery failure. A delivery failure therefore
 * can never roll back an already-committed tenant/property/invitation.
 *
 * pool:               pg Pool (for transactional control)
 * invitationService:  { createInvitationInTransaction } from buildInvitationService
 */
function buildTenantProvisioningService({ pool, invitationService }) {

  /**
   * provisionTenant
   *
   * input: {
   *   companyName:      string (required, min 2)
   *   companyCode:      string (required, [A-Z0-9-]{2,32}, globally unique)
   *   propertyName:     string (required, min 2)
   *   propertyCode:     string (required, [A-Z0-9-]{2,32}, globally unique)
   *   ownerEmail:       string (required, invited as corporate_admin)
   *   timezone:         string (default 'UTC')
   *   subscriptionPlan: string (default 'standard', stored in audit only for now)
   * }
   * ctx: { actorId, actorName, roleCodes, requestId }
   */
  async function provisionTenant(input, ctx) {
    if (!input || typeof input !== 'object') return { ok: false, error: 'invalid_input' };
    const { companyName, companyCode, propertyName, propertyCode, ownerEmail, timezone } = input;

    const errors = [];
    if (!companyName  || String(companyName).trim().length < 2)                    errors.push('companyName required (min 2)');
    if (!companyCode  || !/^[A-Z0-9-]{2,32}$/.test(String(companyCode)))           errors.push('companyCode must be 2-32 uppercase alphanumeric/hyphen');
    if (!propertyName || String(propertyName).trim().length < 2)                   errors.push('propertyName required (min 2)');
    if (!propertyCode || !/^[A-Z0-9-]{2,32}$/.test(String(propertyCode)))          errors.push('propertyCode must be 2-32 uppercase alphanumeric/hyphen');
    if (!ownerEmail   || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(ownerEmail).trim())) errors.push('ownerEmail required and must be valid');
    if (timezone !== undefined && timezone !== null && String(timezone).trim().length === 0) errors.push('timezone, when provided, must not be blank');
    if (errors.length) return { ok: false, error: 'validation_failed', detail: errors.join('; ') };

    // Phase 67A fix: `tenants` has no `timezone` column (see
    // server/src/db/migrations/0001_init.sql — tenants is id/code/name/status/
    // created_at/updated_at only). Timezone belongs to the property record
    // (added by migration 0022_arch_hardening_multiproperty.sql:26,
    // `properties.timezone VARCHAR(64)`). The previous INSERT referenced a
    // nonexistent `tenants.timezone` column and would fail against the real
    // schema on every call.
    const resolvedTimezone = (timezone && String(timezone).trim()) || 'UTC';
    const normalizedOwnerEmail = String(ownerEmail).trim().toLowerCase();

    if (!invitationService || typeof invitationService.createInvitationInTransaction !== 'function') {
      return { ok: false, error: 'invitation_service_unavailable',
               detail: 'invitationService.createInvitationInTransaction is required for atomic provisioning' };
    }

    const client = await pool.connect();
    let tenantId, propertyId, invitation;

    try {
      await client.query('BEGIN');

      const tenantRow = await client.query(
        `INSERT INTO tenants (name, code, status)
         VALUES ($1, $2, 'active')
         RETURNING id`,
        [String(companyName).trim(), String(companyCode).toUpperCase()]
      );
      tenantId = tenantRow.rows[0].id;

      // Set tenant context so RLS WITH CHECK passes on subsequent inserts
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

      const propRow = await client.query(
        `INSERT INTO properties (tenant_id, name, code, active, timezone)
         VALUES ($1, $2, $3, true, $4)
         RETURNING id`,
        [tenantId, String(propertyName).trim(), String(propertyCode).toUpperCase(), resolvedTimezone]
      );
      propertyId = propRow.rows[0].id;

      // Idempotent sweep-job seed (Phase 56 pattern)
      await client.query(
        `INSERT INTO scheduled_jobs
           (tenant_id, property_id, job_type, payload, run_at, recurrence_rule, timezone, next_run_at, max_attempts)
         SELECT $1, NULL, 'booking.hold.expire_sweep', '{}'::jsonb, now(), '*/5 * * * *', 'UTC', now(), 3
          WHERE NOT EXISTS (
            SELECT 1 FROM scheduled_jobs sj
             WHERE sj.tenant_id = $1 AND sj.job_type = 'booking.hold.expire_sweep'
          )`,
        [tenantId]
      );

      // Phase 67A: durable owner-invitation record + notification-outbox row,
      // created INSIDE this same transaction via the shared client — see
      // the function-level doc comment above for why this replaces the old
      // post-commit, separately-transacted invitationService.createInvitation
      // call. role_codes/property_ids on the invitation ARE the "assign
      // approved role" / "assign required company/property membership"
      // steps: they are applied when the invitation is accepted (the
      // established pattern every other invitation in this codebase
      // already uses), not eagerly here. Any failure — including a 23505
      // from a colliding pending invitation — throws and is caught below,
      // rolling back the tenant/property/scheduled-job rows created above.
      invitation = await invitationService.createInvitationInTransaction({
        tenantId,
        email:          normalizedOwnerEmail,
        roleCodes:      ['corporate_admin'],
        propertyIds:    [propertyId],
        invitedBy:      ctx.actorId || null,
        actorRoleCodes: ctx.roleCodes || [],
        client
      });

      await client.query(
        `INSERT INTO audit_events
           (tenant_id, event_type, aggregate_type, aggregate_id, actor_id, request_id, payload)
         VALUES ($1, 'tenant.provisioned', 'tenant', $2, $3, $4, $5)`,
        [
          tenantId,
          tenantId,
          ctx.actorId   || null,
          ctx.requestId || null,
          JSON.stringify({
            company_code:   companyCode,
            property_code:  propertyCode,
            owner_email:    normalizedOwnerEmail,
            invitation_id:  invitation.invitationId,
            provisioned_by: ctx.actorId || null
          })
        ]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return { ok: false, error: 'duplicate_code',
                 detail: 'Company code, property code, or a pending invitation for this email already exists.' };
      }
      if (err.code === 'INVITATION_ROLE_ESCALATION_DENIED') {
        return { ok: false, error: 'invitation_role_escalation_denied', detail: err.message };
      }
      throw err;
    } finally {
      client.release();
    }

    return {
      ok: true,
      tenantId,
      propertyId,
      invitation: { invitationId: invitation.invitationId, email: invitation.email, expiresAt: invitation.expiresAt }
    };
  }

  return { provisionTenant };
}

module.exports = { buildTenantProvisioningService };
