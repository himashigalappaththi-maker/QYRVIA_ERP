'use strict';

/** Phase 27 - AI WhatsApp Booking Agent (foundation, mock): intent, entities, state, Booking Engine. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyIntent } = require('../src/ai-agent/intentClassifier');
const { extractEntities } = require('../src/ai-agent/entityExtractor');
const { buildConversationStateStore } = require('../src/ai-agent/conversationStateStore');
const { buildAiAgentService } = require('../src/ai-agent/aiAgentService');
const { buildAiAgent } = require('../src/ai-agent');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq' };

function fakeBooking(behavior = {}) {
  const calls = [];
  return {
    calls,
    createBooking: async (b, c) => { calls.push({ op: 'create', b, c }); return behavior.create || { ok: true, reservation_id: 'res-1', pricing: { total: 230, currency: 'USD' } }; },
    updateBooking: async (b, c) => { calls.push({ op: 'update', b, c }); return behavior.update || { ok: true, action: 'update', reservation_id: b.reservation_id }; },
    cancelBooking: async (b, c) => { calls.push({ op: 'cancel', b, c }); return behavior.cancel || { ok: true, action: 'cancel' }; }
  };
}
const agent = (bs) => buildAiAgentService({ bookingService: bs, ctx: CTX });

// 1. intent classification
test('intent classification covers all supported intents', () => {
  assert.equal(classifyIntent('I want to book a room'), 'new_booking');
  assert.equal(classifyIntent('please cancel my booking'), 'cancel_booking');
  assert.equal(classifyIntent('can I change my reservation'), 'modify_booking');
  assert.equal(classifyIntent('do you have any rooms'), 'availability_inquiry');
  assert.equal(classifyIntent('how much is a deluxe room'), 'rate_inquiry');
  assert.equal(classifyIntent('hello there'), 'unknown');
});

// 2. entity extraction
test('entity extraction pulls slots from natural language', () => {
  const e = extractEntities("My name is John Smith, a deluxe room from 2026-07-01 to 2026-07-03 for 2 adults");
  assert.equal(e.guest_name, 'John Smith');
  assert.equal(e.room_type, 'deluxe');
  assert.equal(e.arrival, '2026-07-01');
  assert.equal(e.departure, '2026-07-03');
  assert.equal(e.adults, 2);
  assert.equal(extractEntities('cancel res-9').booking_reference, 'res-9');
});

// 3. conversation state handling
test('conversation state is ephemeral and merges across turns', () => {
  const s = buildConversationStateStore({ clock: () => 1000, ttlMs: 0 });
  s.merge('c1', { guest_name: 'Ann' });
  s.merge('c1', { room_type: 'suite' });
  assert.deepEqual(s.get('c1'), { guest_name: 'Ann', room_type: 'suite' });
  assert.deepEqual(s.get('other'), {});
  s.clear('c1');
  assert.deepEqual(s.get('c1'), {});
});

// 4. missing-information flow
test('new booking collects missing slots one at a time', async () => {
  const bs = fakeBooking();
  const a = agent(bs);
  const r1 = await a.handleMessage({ conversationId: 'wa1', text: 'I want to book a deluxe room' });
  assert.equal(r1.intent, 'new_booking');
  assert.equal(r1.action, 'collect');
  assert.equal(r1.missing, 'guest_name');
  assert.match(r1.reply, /guest name/i);
  assert.equal(bs.calls.length, 0); // nothing booked yet
});

// 5 & 9. booking creation path (full conversation) + Booking Engine integration
test('full conversation creates a reservation via BookingService and confirms', async () => {
  const bs = fakeBooking();
  const a = agent(bs);
  await a.handleMessage({ conversationId: 'wa1', text: 'I want to book a deluxe room' });
  await a.handleMessage({ conversationId: 'wa1', text: 'My name is John Smith' });
  await a.handleMessage({ conversationId: 'wa1', text: 'from 2026-07-01 to 2026-07-03' });
  const done = await a.handleMessage({ conversationId: 'wa1', text: '2 adults' });
  assert.equal(done.action, 'created');
  assert.equal(bs.calls.length, 1);
  assert.equal(bs.calls[0].op, 'create');
  assert.equal(bs.calls[0].b.channel, 'AI_WHATSAPP');
  assert.equal(bs.calls[0].b.room_type_id, 'rt-deluxe');
  assert.equal(bs.calls[0].b.guest_name, 'John Smith');
  assert.equal(bs.calls[0].b.adults, 2);
  assert.equal(bs.calls[0].c.tenantId, 't1');        // carries ctx (pms.reservation.write principal)
  assert.match(done.reply, /confirmed/i);
  assert.match(done.reply, /res-1/);
  assert.equal(done.state.booking_reference, 'res-1');
});

// 6. booking update path
test('modify intent updates via BookingService when a reference is known', async () => {
  const bs = fakeBooking();
  const a = agent(bs);
  const r = await a.handleMessage({ conversationId: 'wa2', text: 'change reservation res-7 to 3 adults' });
  assert.equal(r.intent, 'modify_booking');
  assert.equal(r.action, 'updated');
  assert.equal(bs.calls[0].op, 'update');
  assert.equal(bs.calls[0].b.reservation_id, 'res-7');
});

// 7. cancellation path
test('cancel intent cancels via BookingService when a reference is known', async () => {
  const bs = fakeBooking();
  const a = agent(bs);
  const r = await a.handleMessage({ conversationId: 'wa3', text: 'cancel booking res-8' });
  assert.equal(r.intent, 'cancel_booking');
  assert.equal(r.action, 'cancelled');
  assert.equal(bs.calls[0].op, 'cancel');
  assert.equal(bs.calls[0].b.reservation_id, 'res-8');
});

test('cancel without a reference asks for one (no PMS call)', async () => {
  const bs = fakeBooking();
  const a = agent(bs);
  const r = await a.handleMessage({ conversationId: 'wa4', text: 'cancel my booking' });
  assert.equal(r.action, 'need_reference');
  assert.equal(bs.calls.length, 0);
  assert.match(r.reply, /reference/i);
});

// 8. invalid intent
test('unknown intent returns a helpful fallback (no booking)', async () => {
  const bs = fakeBooking();
  const a = agent(bs);
  const r = await a.handleMessage({ conversationId: 'wa5', text: 'hello' });
  assert.equal(r.intent, 'unknown');
  assert.equal(r.action, 'fallback');
  assert.equal(bs.calls.length, 0);
});

// WhatsApp gateway (mock transport) - success criteria end-to-end
test('WhatsApp gateway: inbound message produces an outbound reply via mock transport', async () => {
  const bs = fakeBooking();
  const { gateway } = buildAiAgent({ bookingService: bs, ctx: CTX });
  await gateway.receive({ from: '+15551234', text: 'book a suite, my name is Aisha Khan, from 2026-08-01 to 2026-08-04 for 2 adults', ctx: CTX });
  assert.equal(gateway.transport.outbox.length, 1);
  assert.equal(gateway.transport.outbox[0].to, '+15551234');
  assert.match(gateway.transport.outbox[0].message, /confirmed/i);
  assert.equal(bs.calls[0].op, 'create');
});
