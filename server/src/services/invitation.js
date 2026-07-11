'use strict';

const crypto   = require('crypto');
const identity = require('./identity');

const INVITATION_EXPIRY_DAYS = 7;
const SYSTEM_ROLES = new Set(['super_admin', 'platform_admin']);

function generateInvitationToken() {
  const raw  = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

/**
 * buildInvitationService({ repo })
 *
 * repo contract:
 *   findInvitationByTokenHash(hash) => row | null
 *   findInvitationById(id) => row | null
 *   insertInvitation({ tenant_id, email, token_hash, invited_by, role_codes, property_ids, expires_at }) => row
 *   markInvitationAccepted(id, acceptedBy) => void
 *   markInvitationRevoked(id, revokedBy) => void
 *   listInvitations(tenantId, status?) => row[]
 *   findUserByEmailGlobal(email) => row | null
 *   insertUser(rec) => row
 *   insertUserRoleByCode({ user_id, role_code, tenant_id, property_id, granted_by }) => void
 */
function buildInvitationService({ repo }) {

  async function createInvitation({ tenantId, email, roleCodes, propertyIds, invitedBy, actorRoleCodes }) {
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) {
      return { ok: false, error: 'invalid_email' };
    }
    const normalizedEmail = String(email).trim().toLowerCase();

    const callerIsSuperAdmin = Array.isArray(actorRoleCodes) && actorRoleCodes.includes('super_admin');
    const codes = Array.isArray(roleCodes) && roleCodes.length ? roleCodes : ['staff'];
    if (!callerIsSuperAdmin) {
      const blocked = codes.filter((c) => SYSTEM_ROLES.has(c));
      if (blocked.length) {
        return { ok: false, error: 'role_escalation_denied',
                 detail: `Cannot invite user with system-scoped roles: ${blocked.join(', ')}` };
      }
    }

    try {
      const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
      const { raw, hash } = generateInvitationToken();

      const row = await repo.insertInvitation({
        tenant_id:    tenantId,
        email:        normalizedEmail,
        token_hash:   hash,
        invited_by:   invitedBy || null,
        role_codes:   codes,
        property_ids: Array.isArray(propertyIds) ? propertyIds : [],
        expires_at:   expiresAt
      });

      return { ok: true, invitationId: row.id, rawToken: raw, email: normalizedEmail, expiresAt };
    } catch (err) {
      if (err.code === '23505') {
        return { ok: false, error: 'invitation_already_pending',
                 detail: 'An active invitation already exists for this email in this tenant.' };
      }
      throw err;
    }
  }

  async function acceptInvitation({ token, fullName, password }) {
    if (!token || !fullName || !password) {
      return { ok: false, error: 'missing_fields' };
    }
    if (String(password).length < 8) {
      return { ok: false, error: 'password_too_short', detail: 'Minimum 8 characters.' };
    }

    const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const invitation = await repo.findInvitationByTokenHash(hash);

    if (!invitation)                         return { ok: false, error: 'invitation_not_found' };
    if (invitation.status !== 'pending')     return { ok: false, error: 'invitation_already_used' };
    if (new Date(invitation.expires_at) < new Date()) {
      return { ok: false, error: 'invitation_expired' };
    }

    if (typeof repo.findUserByEmailGlobal === 'function') {
      const existing = await repo.findUserByEmailGlobal(invitation.email);
      if (existing) return { ok: false, error: 'email_already_registered' };
    }

    const passwordHash = await identity.hashPassword(password);
    const username = invitation.email.split('@')[0].replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'user';
    const primaryPropertyId = invitation.property_ids && invitation.property_ids.length
      ? invitation.property_ids[0] : null;

    const user = await repo.insertUser({
      tenant_id:           invitation.tenant_id,
      username,
      email:               invitation.email,
      password_hash:       passwordHash,
      full_name:           String(fullName).trim(),
      primary_property_id: primaryPropertyId,
      status:              'ACTIVE'
    });

    for (const roleCode of (invitation.role_codes || ['staff'])) {
      await repo.insertUserRoleByCode({
        user_id:     user.id,
        role_code:   roleCode,
        tenant_id:   invitation.tenant_id,
        property_id: primaryPropertyId,
        granted_by:  invitation.invited_by || null
      });
    }

    await repo.markInvitationAccepted(invitation.id, user.id);

    return { ok: true, userId: user.id, email: invitation.email };
  }

  async function revokeInvitation({ invitationId, revokedBy }) {
    const row = await repo.findInvitationById(invitationId);
    if (!row)                    return { ok: false, error: 'not_found' };
    if (row.status !== 'pending') return { ok: false, error: 'not_revocable', detail: `Status is ${row.status}` };
    await repo.markInvitationRevoked(invitationId, revokedBy);
    return { ok: true };
  }

  async function listInvitations({ tenantId, status }) {
    return repo.listInvitations(tenantId, status || null);
  }

  return { createInvitation, acceptInvitation, revokeInvitation, listInvitations };
}

module.exports = { buildInvitationService };
