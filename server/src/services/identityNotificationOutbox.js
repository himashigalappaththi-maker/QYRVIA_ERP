'use strict';

const { encryptNotificationPayload } = require('../security/notificationPayloadCrypto');
const config = require('../config/env');

function buildIdentityNotificationOutbox({ notificationRepo }) {
  if (
    !notificationRepo ||
    typeof notificationRepo.insertNotification !== 'function'
  ) {
    const err = new Error('Notification repository required');
    err.code = 'NOTIFICATION_REPOSITORY_REQUIRED';
    throw err;
  }

  async function enqueuePasswordResetNotification(data, client) {
    if (!client || typeof client.query !== 'function') {
      const err = new Error('Notification client required');
      err.code = 'NOTIFICATION_CLIENT_REQUIRED';
      throw err;
    }

    const {
      tenantId,
      identityId,
      resetRecordId,
      email,
      rawToken,
      expiresAt
    } = data || {};

    if (!tenantId || typeof tenantId !== 'string') {
      const err = new Error('tenantId is required');
      err.code = 'OUTBOX_FIELD_REQUIRED';
      throw err;
    }
    if (!identityId || typeof identityId !== 'string') {
      const err = new Error('identityId is required');
      err.code = 'OUTBOX_FIELD_REQUIRED';
      throw err;
    }
    if (!resetRecordId || typeof resetRecordId !== 'string') {
      const err = new Error('resetRecordId is required');
      err.code = 'OUTBOX_FIELD_REQUIRED';
      throw err;
    }
    if (!email || typeof email !== 'string') {
      const err = new Error('email is required');
      err.code = 'OUTBOX_FIELD_REQUIRED';
      throw err;
    }
    if (!rawToken || typeof rawToken !== 'string') {
      const err = new Error('rawToken is required');
      err.code = 'OUTBOX_FIELD_REQUIRED';
      throw err;
    }

    const expiresDate = expiresAt instanceof Date
      ? expiresAt
      : new Date(expiresAt);

    if (Number.isNaN(expiresDate.getTime())) {
      const err = new Error('Password reset expiry invalid');
      err.code = 'PASSWORD_RESET_EXPIRY_INVALID';
      throw err;
    }

    const normalizedExpiresAt = expiresDate.toISOString();

    const resetUrl =
      `${config.APP_BASE_URL}/#/complete-password-reset?token=${encodeURIComponent(rawToken)}`;

    const envelope = encryptNotificationPayload({
      type:      'password_reset',
      email,
      token:     rawToken,
      resetUrl,
      expiresAt: normalizedExpiresAt,
    });

    const result = await notificationRepo.insertNotification({
      tenant_id:   tenantId,
      property_id: null,
      channel:     'email',
      template_code: 'password_reset',
      recipient:   identityId,
      subject:     'Password reset requested',
      body:        'Secure notification payload',
      context:     {},
      status:      'pending',
      requested_by: null,

      encrypted_payload:          envelope.encrypted_payload,
      encryption_iv:              envelope.encryption_iv,
      encryption_tag:             envelope.encryption_tag,
      encryption_payload_version: envelope.encryption_payload_version,
      encryption_key_version:     envelope.encryption_key_version,

      source_idempotency_key: `password-reset:${resetRecordId}`,
    }, client);

    const row     = result.row;
    const created = result.created;

    return { row, created };
  }

  async function enqueueIdentityInvitationNotification(data, client) {
    if (!client || typeof client.query !== 'function') {
      const err = new Error('Notification client required');
      err.code = 'NOTIFICATION_CLIENT_REQUIRED';
      throw err;
    }

    const {
      tenantId,
      identityId,
      invitationRecordId,
      email,
      rawToken,
      expiresAt,
      inviterId
    } = data || {};

    if (!tenantId || typeof tenantId !== 'string') {
      const err = new Error('tenantId is required');
      err.code = 'OUTBOX_FIELD_REQUIRED';
      throw err;
    }
    if (!identityId || typeof identityId !== 'string') {
      const err = new Error('identityId is required');
      err.code = 'OUTBOX_FIELD_REQUIRED';
      throw err;
    }
    if (!invitationRecordId || typeof invitationRecordId !== 'string') {
      const err = new Error('invitationRecordId is required');
      err.code = 'OUTBOX_FIELD_REQUIRED';
      throw err;
    }
    if (!email || typeof email !== 'string') {
      const err = new Error('email is required');
      err.code = 'OUTBOX_FIELD_REQUIRED';
      throw err;
    }
    if (!rawToken || typeof rawToken !== 'string') {
      const err = new Error('rawToken is required');
      err.code = 'OUTBOX_FIELD_REQUIRED';
      throw err;
    }

    const expiresDate = expiresAt instanceof Date
      ? expiresAt
      : new Date(expiresAt);

    if (Number.isNaN(expiresDate.getTime())) {
      const err = new Error('Invitation expiry invalid');
      err.code = 'INVITATION_EXPIRY_INVALID';
      throw err;
    }

    const normalizedExpiresAt = expiresDate.toISOString();

    const invitationUrl =
      `${config.APP_BASE_URL}/#/accept-invitation?token=${encodeURIComponent(rawToken)}`;

    const envelope = encryptNotificationPayload({
      type:          'identity_invitation',
      email,
      token:         rawToken,
      invitationUrl,
      expiresAt:     normalizedExpiresAt,
    });

    const result = await notificationRepo.insertNotification({
      tenant_id:   tenantId,
      property_id: null,
      channel:     'email',
      template_code: 'identity_invitation',
      recipient:   identityId,
      subject:     'You have been invited',
      body:        'Secure notification payload',
      context:     {},
      status:      'pending',
      requested_by: inviterId || null,

      encrypted_payload:          envelope.encrypted_payload,
      encryption_iv:              envelope.encryption_iv,
      encryption_tag:             envelope.encryption_tag,
      encryption_payload_version: envelope.encryption_payload_version,
      encryption_key_version:     envelope.encryption_key_version,

      source_idempotency_key: `identity-invitation:${invitationRecordId}`,
    }, client);

    const row     = result.row;
    const created = result.created;

    return { row, created };
  }

  return { enqueuePasswordResetNotification, enqueueIdentityInvitationNotification };
}

module.exports = { buildIdentityNotificationOutbox };
