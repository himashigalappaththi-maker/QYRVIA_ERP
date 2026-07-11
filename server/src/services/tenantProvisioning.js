'use strict';

/**
 * buildTenantProvisioningService({ pool, invitationService })
 *
 * Creates a complete customer organisation atomically:
 *   1. tenant record
 *   2. first property
 *   3. hold-expiry sweep scheduled job (Phase 56)
 *   4. audit event
 *   5. owner invitation (outside transaction — returns rawToken for delivery)
 *
 * pool:               pg Pool (for transactional control)
 * invitationService:  { createInvitation } from buildInvitationService
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
    if (errors.length) return { ok: false, error: 'validation_failed', detail: errors.join('; ') };

    const client = await pool.connect();
    let tenantId, propertyId;

    try {
      await client.query('BEGIN');

      const tenantRow = await client.query(
        `INSERT INTO tenants (name, code, status, timezone)
         VALUES ($1, $2, 'active', $3)
         RETURNING id`,
        [String(companyName).trim(), String(companyCode).toUpperCase(), timezone || 'UTC']
      );
      tenantId = tenantRow.rows[0].id;

      // Set tenant context so RLS WITH CHECK passes on subsequent inserts
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

      const propRow = await client.query(
        `INSERT INTO properties (tenant_id, name, code, active)
         VALUES ($1, $2, $3, true)
         RETURNING id`,
        [tenantId, String(propertyName).trim(), String(propertyCode).toUpperCase()]
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
            owner_email:    ownerEmail,
            provisioned_by: ctx.actorId || null
          })
        ]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return { ok: false, error: 'duplicate_code',
                 detail: 'Company code or property code already in use.' };
      }
      throw err;
    } finally {
      client.release();
    }

    // Owner invitation is created outside the transaction.
    // Failure here does not roll back the tenant — the admin can re-invite manually.
    const inviteResult = await invitationService.createInvitation({
      tenantId,
      email:          String(ownerEmail).trim().toLowerCase(),
      roleCodes:      ['corporate_admin'],
      propertyIds:    [propertyId],
      invitedBy:      ctx.actorId || null,
      actorRoleCodes: ctx.roleCodes || []
    });

    return {
      ok: true,
      tenantId,
      propertyId,
      invitation: inviteResult.ok ? {
        invitationId: inviteResult.invitationId,
        rawToken:     inviteResult.rawToken,
        email:        inviteResult.email,
        expiresAt:    inviteResult.expiresAt
      } : null,
      invitationError: inviteResult.ok ? null : inviteResult.error
    };
  }

  return { provisionTenant };
}

module.exports = { buildTenantProvisioningService };
