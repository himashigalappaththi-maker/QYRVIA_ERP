'use strict';

/**
 * Phase 27.3 - AI Booking Confirmation: deterministic templates, escalation decision
 * tree, retry/DLQ/idempotent queue, service orchestration, and Booking Engine
 * onEvent integration. Mock transport only; no external calls.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const env = require('../src/config/env');
const { renderConfirmation, hasTemplate, listTemplates } = require('../src/ai-confirmation/confirmationTemplates');
const { decideConfirmation } = require('../src/ai-confirmation/escalationPolicy');
const { buildConfirmationQueue } = require('../src/ai-confirmation/confirmationQueue');
const { buildConfirmationService, buildMockConfirmationTransport, defaultContactResolver } = require('../src/ai-confirmation/confirmationService');
const { buildAiConfirmation } = require('../src/ai-confirmation');
const { buildConfirmationHandlers } = require('../src/ai-confirmation/api/confirmationHandlers');
const confirmationRoutes = require('../src/ai-confirmation/api/confirmation.routes');
const { buildBookingEngine } = require('../src/booking-engine');

function fakeRes() {
  return { _status: null, _json: null, status(c) { this._status = c; return this; }, json(b) { this._json = b; return this; } };
}

const { RetryPolicy } = require('../src/channel-manager/core/sync/RetryPolicy');
const noSleep = () => Promise.resolve();
const fastRetry = new RetryPolicy({ maxAttempts: 3, baseMs: 1, factor: 1, maxMs: 1 });

const CREATED = { type: 'booking.created', tenant_id: 't1', channel: 'AI_WHATSAPP', external_ref: 'wa:+15551234', reservation_id: 'res-1', total: 230, currency: 'USD', guest_name: 'John Smith', arrival: '2026-07-01', departure: '2026-07-03' };

// 0. default-OFF guarantee
test('AI_CONFIRMATION_ENABLED defaults OFF (safe baseline)', () => {
  assert.equal(env.AI_CONFIRMATION_ENABLED, 'false');
});

// 1. templates - deterministic, system-rendered reference + amount
test('templates render created/updated/cancelled with system-rendered reference', () => {
  assert.deepEqual(listTemplates().sort(), ['booking.cancelled', 'booking.created', 'booking.updated']);
  const c = renderConfirmation(CREATED);
  assert.match(c, /confirmed/i);
  assert.match(c, /res-1/);
  assert.match(c, /230 USD/);
  assert.match(c, /2026-07-01 -> 2026-07-03/);
  assert.match(renderConfirmation({ type: 'booking.updated', reservation_id: 'res-2', guest_name: 'Ann' }), /updated/i);
  assert.match(renderConfirmation({ type: 'booking.cancelled', reservation_id: 'res-3' }), /cancelled/i);
  assert.match(renderConfirmation({ type: 'booking.cancelled', reservation_id: 'res-3' }), /there/); // missing guest degrades
  assert.equal(renderConfirmation({ type: 'booking.rejected' }), null);
  assert.equal(hasTemplate('booking.created'), true);
  assert.equal(hasTemplate('booking.rejected'), false);
});

// 2. decision tree
test('decision tree: suppress rejected + unsupported', () => {
  assert.equal(decideConfirmation({ type: 'booking.rejected' }, { recipient: 'x' }).decision, 'suppress');
  assert.equal(decideConfirmation({ type: 'something.else' }, { recipient: 'x' }).decision, 'suppress');
});
test('decision tree: escalate when no recipient', () => {
  const d = decideConfirmation(CREATED, { recipient: null, confidence: 1 });
  assert.equal(d.decision, 'escalate');
  assert.deepEqual(d.reasons, ['no_recipient']);
});
test('decision tree: escalate on low confidence', () => {
  const d = decideConfirmation(CREATED, { recipient: '+1', confidence: 0.2, minConfidence: 0.5 });
  assert.equal(d.decision, 'escalate');
  assert.deepEqual(d.reasons, ['low_confidence']);
});
test('decision tree: escalate when auto-send disabled (manual approval)', () => {
  const d = decideConfirmation(CREATED, { recipient: '+1', confidence: 1, autoSend: false });
  assert.equal(d.decision, 'escalate');
  assert.deepEqual(d.reasons, ['manual_approval_mode']);
});
test('decision tree: auto_confirm when recipient + confident + auto', () => {
  assert.equal(decideConfirmation(CREATED, { recipient: '+1', confidence: 1, autoSend: true }).decision, 'auto_confirm');
});

// 3. recipient resolution
test('default contact resolver decodes wa: external_ref, prefers explicit recipient', () => {
  assert.equal(defaultContactResolver(CREATED), '+15551234');
  assert.equal(defaultContactResolver({ recipient: '+1999', external_ref: 'wa:+1000' }), '+1999');
  assert.equal(defaultContactResolver({ external_ref: 'OTA-123' }), null);
});

// 4. queue: idempotent dedup
test('queue dedups by key (at-most-once delivery)', async () => {
  const tx = buildMockConfirmationTransport();
  const q = buildConfirmationQueue({ transport: tx, retryPolicy: fastRetry, sleep: noSleep });
  assert.equal(q.enqueue({ key: 'k1', to: '+1', message: 'm' }).accepted, true);
  const dup = q.enqueue({ key: 'k1', to: '+1', message: 'm' });
  assert.equal(dup.accepted, false);
  assert.equal(dup.deduped, true);
  assert.equal(q.size(), 1);
  await q.drain();
  assert.equal(tx.outbox.length, 1);
  assert.equal(q.sent.length, 1);
});

// 5. queue: retry then success
test('queue retries a transient failure then succeeds', async () => {
  let n = 0;
  const tx = { async send() { n += 1; if (n < 2) throw new Error('transient'); return { ok: true }; } };
  const q = buildConfirmationQueue({ transport: tx, retryPolicy: fastRetry, sleep: noSleep });
  q.enqueue({ key: 'r1', to: '+1', message: 'm' });
  const res = await q.drain();
  assert.equal(res[0].status, 'sent');
  assert.equal(res[0].attempts, 2);
  assert.equal(q.deadLetter.length, 0);
});

// 6. queue: dead-letter after exhausting retries; isolation (next item still delivered)
test('queue dead-letters after exhausting retries and isolates failures', async () => {
  const tx = {
    async send(to) { if (to === '+bad') throw new Error('down'); return { ok: true }; }
  };
  const q = buildConfirmationQueue({ transport: tx, retryPolicy: fastRetry, sleep: noSleep });
  q.enqueue({ key: 'bad', to: '+bad', message: 'm' });
  q.enqueue({ key: 'good', to: '+good', message: 'm' });
  await q.drain();
  assert.equal(q.deadLetter.length, 1);
  assert.equal(q.deadLetter[0].to, '+bad');
  assert.equal(q.deadLetter[0].attempts, fastRetry.maxAttempts);
  assert.equal(q.sent.length, 1);
  assert.equal(q.sent[0].to, '+good');
});

// 7. service: auto_confirm enqueues then delivers on drain
test('service auto-confirms a created booking and delivers via transport', async () => {
  const svc = buildConfirmationService({ retryPolicy: fastRetry, sleep: noSleep });
  const out = await svc.handleEvent(CREATED);
  assert.equal(out.decision, 'auto_confirm');
  assert.equal(out.to, '+15551234');
  assert.equal(svc.transport.outbox.length, 0); // enqueued only
  await svc.drain();
  assert.equal(svc.transport.outbox.length, 1);
  assert.equal(svc.transport.outbox[0].to, '+15551234');
  assert.match(svc.transport.outbox[0].message, /res-1/);
});

// 8. service: duplicate event delivers once
test('service delivers a duplicate event at most once', async () => {
  const svc = buildConfirmationService({ retryPolicy: fastRetry, sleep: noSleep });
  await svc.handleEvent(CREATED);
  const dup = await svc.handleEvent(CREATED);
  assert.equal(dup.deduped, true);
  await svc.drain();
  assert.equal(svc.transport.outbox.length, 1);
});

// 9. service: escalation path (no recipient) - nothing delivered
test('service escalates when there is no recipient and delivers nothing', async () => {
  const svc = buildConfirmationService({ retryPolicy: fastRetry, sleep: noSleep });
  const out = await svc.handleEvent({ type: 'booking.created', tenant_id: 't1', channel: 'OTA', external_ref: 'OTA-9', reservation_id: 'res-9' });
  assert.equal(out.decision, 'escalate');
  assert.equal(svc.escalations.length, 1);
  assert.equal(svc.escalations[0].reasons[0], 'no_recipient');
  await svc.drain();
  assert.equal(svc.transport.outbox.length, 0);
});

// 10. service: manual-approval mode escalates instead of sending
test('service escalates every confirmation when autoSend is false', async () => {
  const svc = buildConfirmationService({ autoSend: false, retryPolicy: fastRetry, sleep: noSleep });
  const out = await svc.handleEvent(CREATED);
  assert.equal(out.decision, 'escalate');
  assert.equal(out.reasons[0], 'manual_approval_mode');
  assert.equal(out.message.length > 0, true); // message still prepared for the human
  assert.equal(svc.escalations.length, 1);
});

// 11. service: suppress rejection (no guest message)
test('service suppresses a rejected booking', async () => {
  const svc = buildConfirmationService({ retryPolicy: fastRetry, sleep: noSleep });
  const out = await svc.handleEvent({ type: 'booking.rejected', tenant_id: 't1', channel: 'AI_WHATSAPP', external_ref: 'wa:+1', reason: 'ADULT_RULE' });
  assert.equal(out.decision, 'suppress');
  assert.equal(svc.suppressed.length, 1);
  await svc.drain();
  assert.equal(svc.transport.outbox.length, 0);
});

// 12. integration: Booking Engine onEvent feeds confirmation
test('Booking Engine onEvent drives a confirmation for a real create', async () => {
  const commandBus = { dispatch: async () => ({ ok: true, result: { id: 'res-77' } }) };
  const conf = buildAiConfirmation({ retryPolicy: fastRetry, sleep: noSleep });
  // collect events synchronously so the assertion is deterministic (onEvent is fire-and-forget)
  const seen = [];
  const onEvent = (ev) => { seen.push(ev); };
  const engine = buildBookingEngine({ commandBus, onEvent });
  const ctx = { tenantId: 't1', propertyId: 'p1' };
  const r = await engine.service.createBooking({
    channel: 'AI_WHATSAPP', external_ref: 'wa:+15559999', room_type_id: 'rt-deluxe',
    guest_name: 'Aisha', arrival: '2026-08-01', departure: '2026-08-03', adults: 2, base_rate: 100, currency: 'USD'
  }, ctx);
  assert.equal(r.ok, true);
  const created = seen.find((e) => e.type === 'booking.created');
  assert.ok(created, 'booking.created emitted');
  // feed the real emitted event through the confirmation service
  const out = await conf.service.handleEvent(created);
  assert.equal(out.decision, 'auto_confirm');
  assert.equal(out.to, '+15559999');
  await conf.service.drain();
  assert.equal(conf.transport.outbox.length, 1);
  assert.match(conf.transport.outbox[0].message, /res-77/);
});

// 13. API: status reports counters + mode, tenant-scoped
test('API status handler returns tenant-scoped counters', async () => {
  const conf = buildAiConfirmation({ retryPolicy: fastRetry, sleep: noSleep });
  await conf.service.handleEvent(CREATED); // t1 auto_confirm (queued)
  await conf.service.handleEvent({ type: 'booking.created', tenant_id: 't2', channel: 'OTA', external_ref: 'OTA-1', reservation_id: 'res-x' }); // t2 escalate (no recipient)
  const h = buildConfirmationHandlers({ aiConfirmation: conf });
  const res = fakeRes();
  h.status({ ctx: { tenantId: 't2', requestId: 'rq' } }, res);
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.status.escalations, 1); // only t2's escalation
  assert.equal(res._json.status.autoSend, true);
});

// 14. API: escalations + dead-letter listing is tenant-scoped
test('API escalations handler lists only the caller tenant', async () => {
  const conf = buildAiConfirmation({ retryPolicy: fastRetry, sleep: noSleep });
  await conf.service.handleEvent({ type: 'booking.created', tenant_id: 't1', channel: 'OTA', external_ref: 'OTA-1', reservation_id: 'r1' });
  await conf.service.handleEvent({ type: 'booking.created', tenant_id: 't2', channel: 'OTA', external_ref: 'OTA-2', reservation_id: 'r2' });
  const h = buildConfirmationHandlers({ aiConfirmation: conf });
  const res = fakeRes();
  h.escalations({ ctx: { tenantId: 't1' } }, res);
  assert.equal(res._json.items.length, 1);
  assert.equal(res._json.items[0].event.tenant_id, 't1');
});

// 15. API: replay re-queues dead-letters and drains
test('API replay handler re-queues dead-letters then drains', async () => {
  let fail = true;
  const tx = { outbox: [], async send(to, message) { if (fail) throw new Error('down'); this.outbox.push({ to, message }); return { ok: true }; } };
  const conf = buildAiConfirmation({ transport: tx, retryPolicy: fastRetry, sleep: noSleep });
  await conf.service.handleEvent(CREATED);
  await conf.service.drain();                 // fails -> dead-letter
  assert.equal(conf.service.queue.deadLetter.length, 1);
  fail = false;                               // transport recovers
  const h = buildConfirmationHandlers({ aiConfirmation: conf });
  const res = fakeRes();
  await h.replay({ ctx: { tenantId: 't1' } }, res);
  assert.equal(res._json.requeued, 1);
  assert.equal(res._json.processed, 1);
  assert.equal(tx.outbox.length, 1);
  assert.equal(conf.service.queue.deadLetter.length, 0);
});

// 16. route gating: no aiConfirmation dep => empty router (confirmation OFF)
test('routes return an empty router when confirmation is disabled', () => {
  const router = confirmationRoutes.build({});           // no aiConfirmation
  assert.equal(typeof router, 'function');
  assert.equal(router.stack.length, 0);                  // no routes mounted
  const wired = confirmationRoutes.build({ aiConfirmation: buildAiConfirmation({}) });
  assert.equal(wired.stack.length > 0, true);            // routes mounted when wired
});
