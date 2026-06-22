'use strict';

/**
 * Real notification provider adapters.
 *
 * Each adapter exposes:
 *   { name, send({ recipient, subject, body, context }) -> { ok, provider, provider_ref?, error? } }
 *
 * Credentials are read from environment variables ONLY - never accept them
 * via function args. Adapters that need an optional npm package use a lazy
 * try-require so the operator only installs what they use.
 *
 * No real network calls in tests: notificationService is constructed with
 * no providers in test environments, so sendPending returns 'not_configured'
 * automatically. The adapters here ARE real production code; tests for
 * adapters explicitly inject a mock transport.
 */

function _need(modName) {
  try { return require(modName); }
  catch (e) {
    throw new Error('provider requires "' + modName + '" - run `npm install ' + modName + '` to enable it');
  }
}

// -- SMTP via nodemailer ----------------------------------------------------
function buildSmtpProvider({ transport } = {}) {
  // transport is optional - tests inject a stub; production reads env + nodemailer
  let _t = transport;
  function _resolveTransport() {
    if (_t) return _t;
    const required = ['SMTP_HOST','SMTP_USER','SMTP_PASS'];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length) throw new Error('smtp_not_configured: missing ' + missing.join(','));
    const nodemailer = _need('nodemailer');
    _t = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    return _t;
  }
  return {
    name: 'smtp',
    async send({ recipient, subject, body }) {
      try {
        const t = _resolveTransport();
        const info = await t.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to:   recipient, subject: subject || '', text: body
        });
        return { ok: true, provider: 'smtp', provider_ref: info && info.messageId || null };
      } catch (err) {
        return { ok: false, provider: 'smtp', error: String(err.message || err) };
      }
    },
    async health() {
      try {
        const t = _resolveTransport();
        if (typeof t.verify === 'function') await t.verify();
        return { ok: true };
      } catch (err) { return { ok: false, error: String(err.message || err) }; }
    }
  };
}

// -- Resend (HTTP-only, no SDK required) -----------------------------------
function buildResendProvider({ fetchImpl } = {}) {
  const _fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  return {
    name: 'resend',
    async send({ recipient, subject, body }) {
      const key = process.env.RESEND_API_KEY;
      if (!key)    return { ok: false, provider: 'resend', error: 'resend_not_configured' };
      if (!_fetch) return { ok: false, provider: 'resend', error: 'no_fetch_impl' };
      try {
        const resp = await _fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from:    process.env.RESEND_FROM || 'noreply@example.com',
            to:      recipient, subject: subject || '', text: body
          })
        });
        if (!resp.ok) return { ok: false, provider: 'resend', error: 'http_' + resp.status };
        const j = await resp.json().catch(() => ({}));
        return { ok: true, provider: 'resend', provider_ref: j && j.id || null };
      } catch (err) { return { ok: false, provider: 'resend', error: String(err.message || err) }; }
    },
    async health() {
      const key = process.env.RESEND_API_KEY;
      if (!key) return { ok: false, error: 'resend_not_configured' };
      // Resend has /domains as a cheap auth check
      if (!_fetch) return { ok: false, error: 'no_fetch_impl' };
      try {
        const resp = await _fetch('https://api.resend.com/domains', { headers: { 'Authorization': 'Bearer ' + key } });
        return { ok: resp.ok, error: resp.ok ? null : 'http_' + resp.status };
      } catch (err) { return { ok: false, error: String(err.message || err) }; }
    }
  };
}

// -- Twilio SMS (HTTP-only, no SDK required) -------------------------------
function buildTwilioProvider({ fetchImpl } = {}) {
  const _fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  return {
    name: 'twilio',
    async send({ recipient, body }) {
      const sid   = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      const from  = process.env.TWILIO_FROM;
      if (!sid || !token || !from) return { ok: false, provider: 'twilio', error: 'twilio_not_configured' };
      if (!_fetch) return { ok: false, provider: 'twilio', error: 'no_fetch_impl' };
      try {
        const url = 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json';
        const params = new URLSearchParams({ To: recipient, From: from, Body: body }).toString();
        const auth = Buffer.from(sid + ':' + token).toString('base64');
        const resp = await _fetch(url, {
          method:  'POST',
          headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    params
        });
        if (!resp.ok) return { ok: false, provider: 'twilio', error: 'http_' + resp.status };
        const j = await resp.json().catch(() => ({}));
        return { ok: true, provider: 'twilio', provider_ref: j && j.sid || null };
      } catch (err) { return { ok: false, provider: 'twilio', error: String(err.message || err) }; }
    },
    async health() {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      if (!sid || !token) return { ok: false, error: 'twilio_not_configured' };
      if (!_fetch) return { ok: false, error: 'no_fetch_impl' };
      try {
        const url = 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '.json';
        const auth = Buffer.from(sid + ':' + token).toString('base64');
        const resp = await _fetch(url, { headers: { 'Authorization': 'Basic ' + auth } });
        return { ok: resp.ok, error: resp.ok ? null : 'http_' + resp.status };
      } catch (err) { return { ok: false, error: String(err.message || err) }; }
    }
  };
}

// -- WhatsApp Cloud API (Meta) --------------------------------------------
function buildWhatsappCloudProvider({ fetchImpl } = {}) {
  const _fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  return {
    name: 'whatsapp_cloud',
    async send({ recipient, body }) {
      const phoneId = process.env.WA_PHONE_ID;
      const token   = process.env.WA_ACCESS_TOKEN;
      if (!phoneId || !token) return { ok: false, provider: 'whatsapp_cloud', error: 'wa_not_configured' };
      if (!_fetch) return { ok: false, provider: 'whatsapp_cloud', error: 'no_fetch_impl' };
      try {
        const url = 'https://graph.facebook.com/v19.0/' + encodeURIComponent(phoneId) + '/messages';
        const resp = await _fetch(url, {
          method:  'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ messaging_product: 'whatsapp', to: recipient, text: { body } })
        });
        if (!resp.ok) return { ok: false, provider: 'whatsapp_cloud', error: 'http_' + resp.status };
        const j = await resp.json().catch(() => ({}));
        const ref = j && j.messages && j.messages[0] && j.messages[0].id;
        return { ok: true, provider: 'whatsapp_cloud', provider_ref: ref || null };
      } catch (err) { return { ok: false, provider: 'whatsapp_cloud', error: String(err.message || err) }; }
    },
    async health() {
      const phoneId = process.env.WA_PHONE_ID;
      const token   = process.env.WA_ACCESS_TOKEN;
      if (!phoneId || !token) return { ok: false, error: 'wa_not_configured' };
      if (!_fetch) return { ok: false, error: 'no_fetch_impl' };
      try {
        const url = 'https://graph.facebook.com/v19.0/' + encodeURIComponent(phoneId);
        const resp = await _fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
        return { ok: resp.ok, error: resp.ok ? null : 'http_' + resp.status };
      } catch (err) { return { ok: false, error: String(err.message || err) }; }
    }
  };
}

module.exports = {
  buildSmtpProvider, buildResendProvider, buildTwilioProvider, buildWhatsappCloudProvider
};
