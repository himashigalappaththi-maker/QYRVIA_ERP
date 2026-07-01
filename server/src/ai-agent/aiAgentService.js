'use strict';

/**
 * aiAgentService (Phase 27) - orchestrates a WhatsApp booking conversation:
 *   classify intent -> extract entities -> merge ephemeral state -> act.
 *
 * ALL reservation actions go through the Booking Engine (BookingService); the
 * agent NEVER writes PMS/OTA directly and performs no DB mutations of its own.
 * createBooking / updateBooking / cancelBooking are the only side effects, each
 * carrying the caller's ctx (which must hold pms.reservation.write).
 */

const { buildConversationStateStore } = require('./conversationStateStore');
const { buildAiProvider } = require('./provider');

const REQUIRED_NEW = ['guest_name', 'room_type', 'arrival', 'departure', 'adults'];

function buildAiAgentService({ bookingService, provider, stateStore, ctx, rateResolver, roomTypeResolver } = {}) {
  if (!bookingService) throw new Error('aiAgentService: bookingService required');
  const ai = provider || buildAiProvider({ kind: 'mock' });
  const store = stateStore || buildConversationStateStore({});
  const resolveRate = rateResolver || (() => 100);
  const resolveRoomType = roomTypeResolver || ((label) => (label ? 'rt-' + String(label).toLowerCase() : null));
  const baseCtx = ctx || null;

  async function handleMessage({ conversationId, text, ctx: msgCtx } = {}) {
    const cid = conversationId || 'anon';
    const reqCtx = msgCtx || baseCtx;
    const classified = (await ai.classifyIntent(text, {})).intent;
    const entities = await ai.extractEntities(text, { intent: classified });
    let state = store.merge(cid, entities);

    // Slot-filling continuity: a follow-up info message ("2 adults", "res-8") classifies as
    // 'unknown' but should continue the in-progress flow recorded as _active_intent.
    const active = state._active_intent;
    const intent = (classified === 'unknown' && active) ? active : classified;

    let action = null, result = null, missing = null;

    if (intent === 'new_booking') {
      const missingSlots = REQUIRED_NEW.filter((s) => !state[s]);
      if (missingSlots.length) {
        action = 'collect'; missing = missingSlots[0];
      } else {
        const body = {
          channel: 'AI_WHATSAPP', external_ref: 'wa:' + cid,
          room_type_id: resolveRoomType(state.room_type), guest_name: state.guest_name,
          arrival: state.arrival, departure: state.departure,
          adults: Number(state.adults), children: Number(state.children || 0),
          base_rate: resolveRate(state), currency: 'USD'
        };
        const r = await bookingService.createBooking(body, reqCtx);
        if (r && r.ok) { action = 'created'; result = { reservation_id: r.reservation_id, pricing: r.pricing }; state = store.merge(cid, { booking_reference: r.reservation_id }); }
        else { action = 'rejected'; result = { reason: r && r.reason, detail: r && r.detail }; }
      }
    } else if (intent === 'modify_booking') {
      const ref = state.booking_reference;
      if (!ref) { action = 'need_reference'; }
      else {
        const body = {
          reservation_id: ref, channel: 'AI_WHATSAPP',
          room_type_id: state.room_type ? resolveRoomType(state.room_type) : undefined,
          arrival: state.arrival, departure: state.departure,
          adults: state.adults != null ? Number(state.adults) : undefined,
          base_rate: resolveRate(state), currency: 'USD'
        };
        const r = await bookingService.updateBooking(body, reqCtx);
        if (r && r.ok) { action = 'updated'; result = { reservation_id: ref }; }
        else { action = 'rejected'; result = { reason: r && r.reason }; }
      }
    } else if (intent === 'cancel_booking') {
      const ref = state.booking_reference;
      if (!ref) { action = 'need_reference'; }
      else {
        const r = await bookingService.cancelBooking({ reservation_id: ref, channel: 'AI_WHATSAPP' }, reqCtx);
        if (r && r.ok) { action = 'cancelled'; result = { reservation_id: ref }; }
        else { action = 'rejected'; result = { reason: r && r.reason }; }
      }
    } else if (intent === 'availability_inquiry' || intent === 'rate_inquiry') {
      action = 'inquiry';
    } else {
      action = 'fallback';
    }

    // Track the active flow so follow-up info messages continue it; clear it once resolved.
    if (action === 'collect' || action === 'need_reference') {
      state = store.merge(cid, { _active_intent: intent });
    } else {
      const st = store.get(cid);
      if (st._active_intent) { delete st._active_intent; store.set(cid, st); }
    }

    const reply = await ai.generateResponse({ intent, action, missing, result, state });
    const publicState = store.get(cid); delete publicState._active_intent; // internal field hidden
    return { conversationId: cid, intent, action, missing, result, reply, state: publicState };
  }

  return { handleMessage, stateStore: store, REQUIRED_NEW };
}

module.exports = { buildAiAgentService, REQUIRED_NEW };
