'use strict';

const fx = require('./_fixtures');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const np = require('../src/providers/notificationProviders');
const ca = require('../src/providers/connectorAdapters');
const eventBus = require('../src/core/eventBus');

// Snapshot + restore relevant env vars to keep tests hermetic
const ENV_KEYS = [
  'SMTP_HOST','SMTP_USER','SMTP_PASS','SMTP_FROM','SMTP_PORT','SMTP_SECURE',
  'RESEND_API_KEY','RESEND_FROM',
  'TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM',
  'WA_PHONE_ID','WA_ACCESS_TOKEN',
  'ANTHROPIC_API_KEY','OPENAI_API_KEY','OPENROUTER_API_KEY','GEMINI_API_KEY',
  'STRIPE_SECRET_KEY','BOOKING_COM_PROPERTY_ID','BOOKING_COM_API_KEY'
];
const snap = {};
beforeEach(() => {
  for (const k of ENV_KEYS) { snap[k] = process.env[k]; delete process.env[k]; }
  eventBus.reset();
});

function restore() { for (const k of ENV_KEYS) { if (snap[k] === undefined) delete process.env[k]; else process.env[k] = snap[k]; } }

// ---- SMTP -----------------------------------------------------------------
test('smtp.send uses injected transport (no real network)', async () => {
  process.env.SMTP_HOST = 'x'; process.env.SMTP_USER = 'u'; process.env.SMTP_PASS = 'p';
  const called = [];
  const transport = { async sendMail(opts) { called.push(opts); return { messageId: 'mid-1' }; } };
  const p = np.buildSmtpProvider({ transport });
  const r = await p.send({ recipient: 'a@b.c', subject: 's', body: 'hi' });
  restore();
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'smtp');
  assert.equal(r.provider_ref, 'mid-1');
  assert.equal(called.length, 1);
  assert.equal(called[0].to, 'a@b.c');
});

test('smtp.send fails closed when env vars missing', async () => {
  // No env, no transport. Provider must report not_configured.
  const p = np.buildSmtpProvider({});
  const r = await p.send({ recipient: 'a@b.c', body: 'hi' });
  assert.equal(r.ok, false);
  assert.match(r.error, /smtp_not_configured|missing/);
});

test('smtp.health passes through transport.verify()', async () => {
  process.env.SMTP_HOST = 'x'; process.env.SMTP_USER = 'u'; process.env.SMTP_PASS = 'p';
  const transport = { async verify() { return true; }, async sendMail() {} };
  const p = np.buildSmtpProvider({ transport });
  const r = await p.health();
  restore();
  assert.equal(r.ok, true);
});

// ---- Resend ---------------------------------------------------------------
test('resend.send returns not_configured when key missing', async () => {
  const p = np.buildResendProvider({});
  const r = await p.send({ recipient: 'a@b.c', body: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'resend_not_configured');
});

test('resend.send hits api with stubbed fetch', async () => {
  process.env.RESEND_API_KEY = 'rs_test';
  let captured;
  const fakeFetch = async (url, opts) => { captured = { url, opts }; return { ok: true, async json() { return { id: 'em-1' }; } }; };
  const p = np.buildResendProvider({ fetchImpl: fakeFetch });
  const r = await p.send({ recipient: 'a@b.c', subject: 's', body: 'hi' });
  restore();
  assert.equal(r.ok, true);
  assert.equal(r.provider_ref, 'em-1');
  assert.match(captured.url, /api\.resend\.com/);
  assert.match(captured.opts.headers.Authorization, /^Bearer /);
});

// ---- Twilio ---------------------------------------------------------------
test('twilio.send returns not_configured when creds missing', async () => {
  const p = np.buildTwilioProvider({});
  const r = await p.send({ recipient: '+11234567890', body: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'twilio_not_configured');
});

test('twilio.send uses Basic auth + form body', async () => {
  process.env.TWILIO_ACCOUNT_SID = 'AC123';
  process.env.TWILIO_AUTH_TOKEN  = 'tok';
  process.env.TWILIO_FROM        = '+10000000000';
  let captured;
  const fakeFetch = async (url, opts) => { captured = { url, opts }; return { ok: true, async json() { return { sid: 'SM1' }; } }; };
  const p = np.buildTwilioProvider({ fetchImpl: fakeFetch });
  const r = await p.send({ recipient: '+11234567890', body: 'hi' });
  restore();
  assert.equal(r.ok, true);
  assert.equal(r.provider_ref, 'SM1');
  assert.match(captured.opts.headers.Authorization, /^Basic /);
  assert.match(captured.opts.body, /Body=hi/);
});

// ---- WhatsApp Cloud -------------------------------------------------------
test('whatsapp_cloud.send returns not_configured when env missing', async () => {
  const p = np.buildWhatsappCloudProvider({});
  const r = await p.send({ recipient: '+11234567890', body: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'wa_not_configured');
});

test('whatsapp_cloud.send hits graph.facebook with bearer', async () => {
  process.env.WA_PHONE_ID = '12345';
  process.env.WA_ACCESS_TOKEN = 'wa_token';
  let captured;
  const fakeFetch = async (url, opts) => { captured = { url, opts }; return { ok: true, async json() { return { messages: [{ id: 'wamid.1' }] }; } }; };
  const p = np.buildWhatsappCloudProvider({ fetchImpl: fakeFetch });
  const r = await p.send({ recipient: '+11234567890', body: 'hi' });
  restore();
  assert.equal(r.ok, true);
  assert.equal(r.provider_ref, 'wamid.1');
  assert.match(captured.url, /graph\.facebook\.com/);
});

// ---- Connector adapters ----------------------------------------------------
test('anthropic.probe returns ok when env present, fails otherwise', async () => {
  const a = ca.buildAnthropicAdapter({});
  let r = await a.probe(); assert.equal(r.ok, false);
  process.env.ANTHROPIC_API_KEY = 'sk_x';
  r = await a.probe(); assert.equal(r.ok, true);
  restore();
});

test('openai.health uses /models with bearer (stubbed)', async () => {
  process.env.OPENAI_API_KEY = 'sk_x';
  const fakeFetch = async (url, opts) => ({ ok: true, status: 200 });
  const a = ca.buildOpenAIAdapter({ fetchImpl: fakeFetch });
  const r = await a.health();
  restore();
  assert.equal(r.ok, true);
  assert.equal(typeof r.latency_ms, 'number');
});

test('stripe.probe reports STRIPE_SECRET_KEY missing', async () => {
  const a = ca.buildStripeAdapter({});
  const r = await a.probe();
  assert.equal(r.ok, false);
  assert.match(r.detail, /STRIPE_SECRET_KEY/);
});

test('openrouter.health 401 surfaces http_401', async () => {
  process.env.OPENROUTER_API_KEY = 'sk_x';
  const a = ca.buildOpenRouterAdapter({ fetchImpl: async () => ({ ok: false, status: 401 }) });
  const r = await a.health();
  restore();
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'http_401');
});

test('booking_com adapter capabilities lists supply-side methods', () => {
  const a = ca.buildBookingComAdapter({});
  const caps = a.capabilities();
  assert.ok(caps.includes('rate_push'));
  assert.ok(caps.includes('availability_push'));
});

test('every notification provider exposes name + send + health', () => {
  const provs = [np.buildSmtpProvider({}), np.buildResendProvider({}), np.buildTwilioProvider({}), np.buildWhatsappCloudProvider({})];
  for (const p of provs) {
    assert.ok(p.name);
    assert.equal(typeof p.send, 'function');
    assert.equal(typeof p.health, 'function');
  }
});

test('every connector adapter exposes capabilities + probe + health', () => {
  const ads = [
    ca.buildAnthropicAdapter({}), ca.buildOpenAIAdapter({}), ca.buildOpenRouterAdapter({}),
    ca.buildGeminiAdapter({}), ca.buildStripeAdapter({}), ca.buildBookingComAdapter({})
  ];
  for (const a of ads) {
    assert.equal(typeof a.capabilities, 'function');
    assert.equal(typeof a.probe, 'function');
    assert.equal(typeof a.health, 'function');
  }
});
