'use strict';

/**
 * housekeepingSubscriber - converts upstream room/stay events into housekeeping
 * tasks. SUBSCRIBES only; never calls back into the Room / Reservation / Front
 * Desk / Billing engines.
 *
 *   stay.ended            -> Checkout Cleaning task
 *   stay.room_moved / room.moved -> Transfer Cleaning task (vacated room)
 *   maintenance.completed -> Inspection task
 *   vip.arrival.flagged   -> VIP Preparation task (high priority)
 */

const { TASK_TYPE } = require('../models/HousekeepingModels');

function ctxFromEvent(e) {
  return { tenantId: e.tenant_id, propertyId: e.property_id, requestId: 'hk-sub-' + (e.event_id || 'na'), userId: e.actor_id || null };
}

function buildHousekeepingSubscriber({ eventBus, housekeeping } = {}) {
  if (!eventBus) throw new Error('housekeepingSubscriber: eventBus required');
  if (!housekeeping) throw new Error('housekeepingSubscriber: housekeeping required');

  const unsubs = [];
  const on = (type, handler) => unsubs.push(eventBus.subscribe(type, async (e) => {
    try { await handler(e); } catch (_) { /* isolated */ }
  }));

  on('stay.ended', async (e) => {
    const p = e.payload || {};
    if (!p.room_id) return;
    await housekeeping.createTask(ctxFromEvent(e), {
      roomId: p.room_id, taskType: TASK_TYPE.CHECKOUT_CLEANING,
      factors: { checkoutCompleted: true }, zone: p.zone || null, roomType: p.room_type || null });
  });

  const transfer = async (e) => {
    const p = e.payload || {};
    const vacated = p.from_room_id || p.from || p.room_id;
    if (!vacated) return;
    await housekeeping.createTask(ctxFromEvent(e), {
      roomId: vacated, taskType: TASK_TYPE.TRANSFER_CLEANING, factors: { checkoutCompleted: true }, zone: p.zone || null });
  };
  on('stay.room_moved', transfer);
  on('room.moved', transfer);

  on('maintenance.completed', async (e) => {
    const p = e.payload || {};
    if (!p.room_id) return;
    await housekeeping.createTask(ctxFromEvent(e), {
      roomId: p.room_id, taskType: TASK_TYPE.INSPECTION, factors: { maintenanceDependency: true }, zone: p.zone || null });
  });

  on('vip.arrival.flagged', async (e) => {
    const p = e.payload || {};
    if (!p.room_id) return;
    await housekeeping.createTask(ctxFromEvent(e), {
      roomId: p.room_id, taskType: TASK_TYPE.VIP_PREPARATION,
      factors: { vipGuest: true, arrivingGuestToday: true, suiteCategory: !!p.suite }, zone: p.zone || null });
  });

  return function unsubscribe() { unsubs.forEach((u) => { try { u(); } catch (_) { /* ignore */ } }); };
}

module.exports = { buildHousekeepingSubscriber, ctxFromEvent };
