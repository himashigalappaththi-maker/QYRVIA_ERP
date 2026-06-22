'use strict';

/**
 * Reservation Group commands (Phase 7 / C5).
 *
 *   pms.reservation_group.create
 *   pms.reservation_group.add_room      -- attach an existing reservation
 *   pms.reservation_group.cancel_all    -- cascade cancellation
 *   pms.reservation_group.checkin_all   -- attempt to check-in all CONFIRMED members
 *
 * Cross-property attaches are rejected. A cascade cancel refuses if any
 * member is CHECKED_IN unless `force=true`.
 */

const { makeEvent } = require('../../core/event');

const GROUP_TYPES = ['GROUP','TOUR_SERIES','WEDDING','CONFERENCE','OTHER'];

function makeReservationGroupCommands({ pmsRepo, commandBus, settingsService }) {
  if (!pmsRepo)    throw new Error('pmsRepo required');
  if (!commandBus) throw new Error('commandBus required');
  const cmds = [];

  cmds.push({
    name: 'pms.reservation_group.create',
    aggregateType: 'reservation_group',
    permission: 'reservation.group.write',
    async handler(input, ctx) {
      if (!ctx.tenantId || !ctx.propertyId) return { ok: false, error: 'tenant_and_property_required' };
      if (!input.code || !input.name)       return { ok: false, error: 'code_and_name_required' };
      const gtype = input.group_type || 'GROUP';
      if (!GROUP_TYPES.includes(gtype))     return { ok: false, error: 'invalid_group_type' };
      try {
        const row = await pmsRepo.insertReservationGroup({
          tenant_id: ctx.tenantId, property_id: ctx.propertyId,
          group_type: gtype, code: input.code, name: input.name,
          holder_guest_id: input.holder_guest_id || null,
          arrival_date: input.arrival_date || null, departure_date: input.departure_date || null,
          cutoff_date: input.cutoff_date || null, notes: input.notes || null,
          created_by: ctx.actorId
        });
        return { ok: true, result: { id: row.id, code: row.code, group_type: row.group_type }, events: [
          makeEvent({ type: 'reservation_group.created', aggregateType: 'reservation_group',
            aggregateId: row.id,
            payload: { code: row.code, group_type: row.group_type, name: row.name,
                       property_id: ctx.propertyId }, ctx })
        ]};
      } catch (e) { return { ok: false, error: 'validation_failed', detail: e.message }; }
    }
  });

  cmds.push({
    name: 'pms.reservation_group.add_room',
    aggregateType: 'reservation_group',
    permission: 'reservation.group.write',
    async handler(input, ctx) {
      if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
      if (!input.group_id || !input.reservation_id)
        return { ok: false, error: 'group_id_and_reservation_id_required' };
      const grp = await pmsRepo.findReservationGroupById(ctx.tenantId, input.group_id);
      if (!grp) return { ok: false, error: 'group_not_found' };
      const res = await pmsRepo.findReservationById(ctx.tenantId, input.reservation_id);
      if (!res) return { ok: false, error: 'reservation_not_found' };
      if (res.property_id !== grp.property_id) return { ok: false, error: 'property_mismatch' };
      if (res.group_id && res.group_id !== grp.id)
        return { ok: false, error: 'already_in_another_group' };
      const updated = await pmsRepo.attachReservationToGroup(ctx.tenantId, res.id, grp.id);
      // Bump group totals (rooms_count default 1; adults+children as guests)
      const guests = (Number(res.adults) || 0) + (Number(res.children) || 0);
      await pmsRepo.bumpGroupTotals(ctx.tenantId, grp.id,
        { roomsDelta: Number(res.rooms_count) || 1, guestsDelta: guests });
      return { ok: true, result: { reservation_id: updated.id, group_id: grp.id }, events: [
        makeEvent({ type: 'reservation_group.room_added', aggregateType: 'reservation_group',
          aggregateId: grp.id,
          payload: { group_id: grp.id, reservation_id: updated.id,
                     reservation_number: updated.reservation_number }, ctx })
      ]};
    }
  });

  cmds.push({
    name: 'pms.reservation_group.cancel_all',
    aggregateType: 'reservation_group',
    permission: 'reservation.group.write',
    async handler(input, ctx) {
      if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
      if (!input.group_id) return { ok: false, error: 'group_id_required' };
      const grp = await pmsRepo.findReservationGroupById(ctx.tenantId, input.group_id);
      if (!grp) return { ok: false, error: 'group_not_found' };
      const members = await pmsRepo.listReservationsInGroup(ctx.tenantId, grp.id);
      const checkedIn = members.filter((m) => m.status === 'CHECKED_IN');
      if (checkedIn.length > 0 && !input.force) {
        return { ok: false, error: 'members_checked_in',
                 detail: 'count=' + checkedIn.length + '; pass force=true to override' };
      }
      const cancelled = [];
      for (const m of members) {
        if (['CANCELLED','NO_SHOW','CHECKED_OUT'].includes(m.status)) continue;
        if (m.status === 'CHECKED_IN' && !input.force) continue;
        // Dispatch a real cancel so the standard audit/eventBus chain fires.
        const r = await commandBus.dispatch('pms.reservation.cancel',
          { reservation_id: m.id, reason: input.reason || 'group_cancellation' },
          Object.assign({}, ctx));
        if (r.ok) cancelled.push(m.id);
      }
      return { ok: true, result: { cancelled_count: cancelled.length, total_members: members.length },
               events: [ makeEvent({ type: 'reservation_group.cancelled', aggregateType: 'reservation_group',
                 aggregateId: grp.id,
                 payload: { group_id: grp.id, cancelled_count: cancelled.length,
                            total_members: members.length,
                            reason: input.reason || 'group_cancellation' }, ctx }) ]};
    }
  });

  cmds.push({
    name: 'pms.reservation_group.checkin_all',
    aggregateType: 'reservation_group',
    permission: 'reservation.group.write',
    async handler(input, ctx) {
      if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
      if (!input.group_id) return { ok: false, error: 'group_id_required' };
      const grp = await pmsRepo.findReservationGroupById(ctx.tenantId, input.group_id);
      if (!grp) return { ok: false, error: 'group_not_found' };
      const members = await pmsRepo.listReservationsInGroup(ctx.tenantId, grp.id);
      const failures = [];
      const checkedIn = [];
      for (const m of members) {
        if (m.status !== 'CONFIRMED') continue;
        const r = await commandBus.dispatch('pms.reservation.checkin',
          { reservation_id: m.id, assigned_room_id: null },
          Object.assign({}, ctx));
        if (r.ok) checkedIn.push(m.id);
        else      failures.push({ reservation_id: m.id, error: r.error, detail: r.detail });
      }
      return { ok: true, result: { checked_in_count: checkedIn.length, failures },
               events: [ makeEvent({ type: 'reservation_group.checked_in_all', aggregateType: 'reservation_group',
                 aggregateId: grp.id,
                 payload: { group_id: grp.id, checked_in_count: checkedIn.length,
                            failure_count: failures.length }, ctx }) ]};
    }
  });

  return cmds;
}

module.exports = { makeReservationGroupCommands };
