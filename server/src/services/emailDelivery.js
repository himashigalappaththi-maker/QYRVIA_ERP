'use strict';

/**
 * buildEmailDelivery({ provider, baseUrl })
 *
 * Thin service that composes plain-text transactional emails for identity
 * events (invitation, password reset) and hands them to the injected email
 * provider.  When provider is null (not configured) all sends return
 * { ok: false, reason: 'email_not_configured' } without throwing.
 *
 * provider must satisfy: { send({ recipient, subject, body }) -> { ok, ... } }
 * baseUrl: e.g. 'https://app.qyrvia.com' — used to build deep-link URLs.
 */
function buildEmailDelivery({ provider = null, baseUrl = 'http://localhost:3001' } = {}) {

  function _link(path, params) {
    const q = Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    // Hash-SPA navigation: #/<path>?<params>
    return `${baseUrl}/#/${path}?${q}`;
  }

  async function sendInvitationEmail(email, rawToken, expiresAt) {
    if (!provider) return { ok: false, reason: 'email_not_configured' };
    const link = _link('accept-invitation', { token: rawToken });
    const expires = expiresAt instanceof Date
      ? expiresAt.toUTCString()
      : new Date(expiresAt).toUTCString();
    return provider.send({
      recipient: email,
      subject:   'You have been invited to QYRVIA',
      body: [
        'You have been invited to join QYRVIA.',
        '',
        'Click the link below to create your account:',
        link,
        '',
        'This invitation expires: ' + expires,
        '',
        'If you did not expect this invitation you can safely ignore this email.'
      ].join('\n')
    });
  }

  async function sendPasswordResetEmail(email, rawToken, expiresAt) {
    if (!provider) return { ok: false, reason: 'email_not_configured' };
    const link = _link('complete-password-reset', { token: rawToken });
    const expires = expiresAt instanceof Date
      ? expiresAt.toUTCString()
      : new Date(expiresAt).toUTCString();
    return provider.send({
      recipient: email,
      subject:   'QYRVIA password reset',
      body: [
        'A password reset was requested for your QYRVIA account.',
        '',
        'Click the link below to set a new password:',
        link,
        '',
        'This link expires: ' + expires,
        '',
        'If you did not request a password reset you can safely ignore this email.',
        'Your password will not change until you follow the link above.'
      ].join('\n')
    });
  }

  return { sendInvitationEmail, sendPasswordResetEmail };
}

module.exports = { buildEmailDelivery };
