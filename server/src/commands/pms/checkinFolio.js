'use strict';

/**
 * Check-In, Check-Out and Folio commands (Phase 5.5 readiness).
 *
 *   pms.reservation.checkin   - CONFIRMED -> CHECKED_IN; auto-opens folio.
 *   pms.reservation.checkout  - CHECKED_IN -> CHECKED_OUT; auto-closes folio.
 *   pms.folio.open            - opens a folio explicitly (e.g. for a walk-in)
 *   pms.folio.charge.post     - posts a folio line (accountingSensitive)
 *   pms.folio.close           - closes a folio (accountingSensitive)
 *   pms.housekeeping.task.create / .assign / .complete
 *
 * The check-in / check-out transitions are NOT marked accountingSensitive
 * because Phase 5.5 ships them as foundation; once Folio + Finance gain
 * the ability to lock the period mid-night-audit, the FOLIO posting
 * underneath is what's accountingSensitive, not the status change.
 *
 * Folio charge.post and close ARE accountingSensitive: posting during
 * the lock would corrupt the audit total. The Night Audit command itself
 * runs WITHOUT the guard (acceptsBusinessDateLocked:true).
 */

const { makeEvent } = require('../../core/event');

function pad6(n) { const s = String(n); return s.length >= 6 ? s : '0'.repeat(6 - s.length) + s; }

function makeCheckinFolioCommands({ pmsRepo, folioRepo, housekeepingRepo }) {
  if (!pmsRepo)         throw new Error('pmsRepo required');
  if (!folioRepo)       throw new Error('folioRepo required');
  if (!housekeepingRepo)throw new Error('housekeepingRepo required');

  const cmds = [];

  // ---- pms.reservation.checkin ----------------------------------------
  cmds.push({
    name: 'pms.reservation.checkin',
    aggregateType: 'reservation',
    permission: 'pms.reservation.write',
    async handler(input, ctx) {
      if (!ctx.tenantId)   return { ok: false, error: 'tenant_required' };
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      if (!input.reservation_id) return { ok: false, error: 'reservation_id_required' };

      const before = await pmsRepo.findReservationById(ctx.tenantId, input.reservation_id);
      if (!before) return { ok: false, error: 'reservation_not_found' };
      if (before.status !== 'CONFIRMED') {
        return { ok: false, error: 'invalid_transition', detail: 'from ' + before.status };
      }
      const fromStatus = before.status;

      // Optional assigned_room_id; if provided, verify ownership.
      let assignedRoomId = input.assigned_room_id || before.assigned_room_id || null;
      if (input.assigned_room_id) {
        const room = await pmsRepo.findRoomById(ctx.tenantId, input.assigned_room_id);
        if (!room || room.property_id !== ctx.propertyId) {
          return { ok: false, error: 'room_not_found' };
        }
        if (room.status === 'OCCUPIED') {
          return { ok: false, error: 'room_occupied' };
        }
        assignedRoomId = room.id;
      }

      const updated = await pmsRepo.checkInReservation(ctx.tenantId, input.reservation_id, {
        userId: ctx.actorId, businessDate: ctx.businessDate,
        assignedRoomId
      });

      // Auto-open folio
      const year = new Date().getUTCFullYear();
      const property = await pmsRepo.findPropertyById(ctx.tenantId, ctx.propertyId);
      const seq = await folioRepo.bumpFolioCounter({ tenantId: ctx.tenantId, propertyId: ctx.propertyId, year });
      const folioNumber = (property && property.code ? property.code : 'P') + '-F-' + year + '-' + pad6(seq);
      const folio = await folioRepo.insertFolio({
        tenant_id: ctx.tenantId, property_id: ctx.propertyId,
        reservation_id: updated.id, folio_number: folioNumber,
        status: 'OPEN', currency: property && property.currency || 'LKR',
        guest_id: updated.holder_guest_id, business_date: ctx.businessDate,
        created_by: ctx.actorId
      });

      return { ok: true, result: { id: updated.id, status: updated.status, folio_id: folio.id, folio_number: folioNumber },
               events: [
                 makeEvent({ type: 'reservation.checked_in', aggregateType: 'reservation',
                   aggregateId: updated.id,
                   payload: { reservation_number: updated.reservation_number,
                              from: fromStatus, to: updated.status,
                              assigned_room_id: assignedRoomId,
                              business_date: ctx.businessDate }, ctx }),
                 makeEvent({ type: 'folio.opened', aggregateType: 'folio',
                   aggregateId: folio.id,
                   payload: { folio_number: folioNumber,
                              reservation_id: updated.id,
                              business_date: ctx.businessDate }, ctx })
               ]};
    }
  });

  // ---- pms.reservation.checkout ---------------------------------------
  cmds.push({
    name: 'pms.reservation.checkout',
    aggregateType: 'reservation',
    permission: 'pms.reservation.write',
    async handler(input, ctx) {
      if (!ctx.tenantId)   return { ok: false, error: 'tenant_required' };
      if (!input.reservation_id) return { ok: false, error: 'reservation_id_required' };

      const before = await pmsRepo.findReservationById(ctx.tenantId, input.reservation_id);
      if (!before) return { ok: false, error: 'reservation_not_found' };
      if (before.status !== 'CHECKED_IN') {
        return { ok: false, error: 'invalid_transition', detail: 'from ' + before.status };
      }
      const fromStatus = before.status;

      // Check folio balance (if any) - non-zero balance blocks checkout
      // unless explicitly forced (input.force_close=true with the
      // accounting role - we keep it simple here and let the caller decide).
      const folios = await folioRepo.listFoliosForReservation(ctx.tenantId, input.reservation_id);
      const openFolio = folios.find((f) => f.status === 'OPEN');
      if (openFolio && Number(openFolio.balance) !== 0 && !input.force_close) {
        return { ok: false, error: 'folio_has_balance',
                 detail: 'balance=' + openFolio.balance + ' folio_id=' + openFolio.id };
      }

      const updated = await pmsRepo.checkOutReservation(ctx.tenantId, input.reservation_id, { userId: ctx.actorId });

      let closedFolio = null;
      if (openFolio) {
        closedFolio = await folioRepo.closeFolio(ctx.tenantId, openFolio.id);
      }

      // Create a housekeeping task for the vacated room
      let hkTask = null;
      if (updated.assigned_room_id) {
        hkTask = await housekeepingRepo.insertTask({
          tenant_id: ctx.tenantId, property_id: ctx.propertyId || updated.property_id,
          room_id: updated.assigned_room_id, reservation_id: updated.id,
          task_type: 'CLEAN_DEPARTURE', status: 'PENDING', priority: 2,
          scheduled_for: ctx.businessDate, notes: 'auto-created on checkout',
          created_by: ctx.actorId
        });
      }

      const events = [
        makeEvent({ type: 'reservation.checked_out', aggregateType: 'reservation',
          aggregateId: updated.id,
          payload: { reservation_number: updated.reservation_number,
                     from: fromStatus, to: updated.status,
                     mode: input.mode || 'STANDARD',
                     folio_id: closedFolio && closedFolio.id || null,
                     business_date: ctx.businessDate }, ctx })
      ];
      if (closedFolio) {
        events.push(makeEvent({ type: 'folio.closed', aggregateType: 'folio',
          aggregateId: closedFolio.id,
          payload: { folio_number: closedFolio.folio_number, balance: closedFolio.balance,
                     reservation_id: updated.id, business_date: ctx.businessDate }, ctx }));
      }
      if (hkTask) {
        events.push(makeEvent({ type: 'housekeeping.task_created', aggregateType: 'housekeeping_task',
          aggregateId: hkTask.id,
          payload: { task_type: hkTask.task_type, room_id: hkTask.room_id,
                     reservation_id: updated.id }, ctx }));
      }

      return { ok: true, result: { id: updated.id, status: updated.status,
                                    folio_id: closedFolio && closedFolio.id || null,
                                    housekeeping_task_id: hkTask && hkTask.id || null },
               events };
    }
  });

  // ---- pms.folio.charge.post  (accountingSensitive) -------------------
  cmds.push({
    name: 'pms.folio.charge.post',
    aggregateType: 'folio',
    permission: 'folio.post',
    accountingSensitive: true,
    async handler(input, ctx) {
      if (!ctx.tenantId)   return { ok: false, error: 'tenant_required' };
      if (!input.folio_id) return { ok: false, error: 'folio_id_required' };
      const folio = await folioRepo.findFolioById(ctx.tenantId, input.folio_id);
      if (!folio)          return { ok: false, error: 'folio_not_found' };
      if (folio.status !== 'OPEN') return { ok: false, error: 'folio_not_open' };

      const VALID_CT = ['ROOM','ROOM_TAX','PACKAGE','EXTRA_BED','MINIBAR','POS_CHARGE','LAUNDRY',
                        'TELEPHONE','INTERNET','SPA','TRANSFER','MISC','PAYMENT','REFUND',
                        'ADJUSTMENT','DEPOSIT'];
      if (!VALID_CT.includes(input.charge_type)) return { ok: false, error: 'invalid_charge_type' };
      if (!Number.isFinite(input.amount))        return { ok: false, error: 'amount_required' };

      const line = await folioRepo.insertFolioLine({
        tenant_id: ctx.tenantId, folio_id: folio.id,
        charge_type: input.charge_type,
        description: input.description || null,
        quantity: input.quantity || 1, unit_amount: input.unit_amount || input.amount,
        amount: input.amount, tax_amount: input.tax_amount || 0,
        business_date: ctx.businessDate || folio.business_date,
        posted_by: ctx.actorId, source_module: input.source_module || 'PMS',
        source_ref: input.source_ref || null, metadata: input.metadata || {}
      });
      return { ok: true, result: { line_id: line.id, folio_id: folio.id },
               events: [ makeEvent({ type: 'folio.charge_posted', aggregateType: 'folio',
                 aggregateId: folio.id,
                 payload: { folio_id: folio.id, charge_type: line.charge_type,
                            amount: line.amount, business_date: line.business_date,
                            source_module: line.source_module }, ctx }) ]};
    }
  });

  // ---- pms.folio.payment.cash (Phase 7 / C10, accountingSensitive) ----
  cmds.push({
    name: 'pms.folio.payment.cash',
    aggregateType: 'folio',
    permission: 'folio.post',
    accountingSensitive: true,
    async handler(input, ctx) {
      if (!ctx.tenantId)   return { ok: false, error: 'tenant_required' };
      if (!input.folio_id) return { ok: false, error: 'folio_id_required' };
      if (!Number.isFinite(input.amount) || input.amount <= 0)
        return { ok: false, error: 'amount_required' };
      if (!Number.isFinite(input.tendered) || input.tendered <= 0)
        return { ok: false, error: 'tendered_required' };
      if (input.tendered < input.amount)
        return { ok: false, error: 'tender_insufficient',
                 detail: 'tendered=' + input.tendered + ' due=' + input.amount };
      const folio = await folioRepo.findFolioById(ctx.tenantId, input.folio_id);
      if (!folio) return { ok: false, error: 'folio_not_found' };
      if (folio.status !== 'OPEN') return { ok: false, error: 'folio_not_open' };
      const change = Math.round((input.tendered - input.amount) * 100) / 100;
      // Payment lines store NEGATIVE amounts (per Phase 5.5 convention).
      const line = await folioRepo.insertFolioLine({
        tenant_id: ctx.tenantId, folio_id: folio.id,
        charge_type: 'PAYMENT',
        description: input.description || 'Cash payment',
        quantity: 1, unit_amount: -input.amount, amount: -input.amount,
        tax_amount: 0,
        business_date: ctx.businessDate || folio.business_date,
        posted_by: ctx.actorId, source_module: 'PMS',
        source_ref: null,
        metadata: { method: 'CASH', tendered: input.tendered, change }
      });
      return { ok: true, result: { line_id: line.id, folio_id: folio.id,
                                    tendered: input.tendered, change },
               events: [ makeEvent({ type: 'folio.payment_received', aggregateType: 'folio',
                 aggregateId: folio.id,
                 payload: { folio_id: folio.id, method: 'CASH',
                            amount: input.amount, tendered: input.tendered, change,
                            business_date: ctx.businessDate || folio.business_date }, ctx }) ]};
    }
  });

  // ---- pms.folio.close (accountingSensitive) --------------------------
  cmds.push({
    name: 'pms.folio.close',
    aggregateType: 'folio',
    permission: 'folio.close',
    accountingSensitive: true,
    async handler(input, ctx) {
      if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
      if (!input.folio_id) return { ok: false, error: 'folio_id_required' };
      const f = await folioRepo.findFolioById(ctx.tenantId, input.folio_id);
      if (!f)              return { ok: false, error: 'folio_not_found' };
      if (f.status !== 'OPEN') return { ok: false, error: 'folio_not_open' };
      if (Number(f.balance) !== 0 && !input.force) {
        return { ok: false, error: 'folio_has_balance', detail: 'balance=' + f.balance };
      }
      const closed = await folioRepo.closeFolio(ctx.tenantId, f.id);
      return { ok: true, result: { id: closed.id, status: closed.status },
               events: [ makeEvent({ type: 'folio.closed', aggregateType: 'folio',
                 aggregateId: closed.id,
                 payload: { folio_number: closed.folio_number, balance: closed.balance,
                            business_date: closed.business_date }, ctx }) ]};
    }
  });

  // ---- pms.housekeeping.task.create -----------------------------------
  cmds.push({
    name: 'pms.housekeeping.task.create',
    aggregateType: 'housekeeping_task',
    permission: 'housekeeping.assign',
    async handler(input, ctx) {
      if (!ctx.tenantId)   return { ok: false, error: 'tenant_required' };
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      if (!input.task_type) return { ok: false, error: 'task_type_required' };
      const VALID = ['CLEAN_DEPARTURE','CLEAN_STAYOVER','INSPECT','LINEN_CHANGE',
                     'TURNDOWN','DEEP_CLEAN','MAINTENANCE','LOST_AND_FOUND','OTHER'];
      if (!VALID.includes(input.task_type)) return { ok: false, error: 'invalid_task_type' };
      const row = await housekeepingRepo.insertTask({
        tenant_id: ctx.tenantId, property_id: ctx.propertyId,
        room_id: input.room_id || null, reservation_id: input.reservation_id || null,
        task_type: input.task_type, priority: input.priority || 3,
        scheduled_for: input.scheduled_for || null, notes: input.notes || null,
        created_by: ctx.actorId
      });
      return { ok: true, result: { id: row.id },
               events: [ makeEvent({ type: 'housekeeping.task_created', aggregateType: 'housekeeping_task',
                 aggregateId: row.id,
                 payload: { task_type: row.task_type, room_id: row.room_id,
                            reservation_id: row.reservation_id }, ctx }) ]};
    }
  });

  // ---- pms.housekeeping.task.assign -----------------------------------
  cmds.push({
    name: 'pms.housekeeping.task.assign',
    aggregateType: 'housekeeping_task',
    permission: 'housekeeping.assign',
    async handler(input, ctx) {
      if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
      if (!input.task_id || !input.user_id) return { ok: false, error: 'task_id_and_user_id_required' };
      const t = await housekeepingRepo.findTaskById(ctx.tenantId, input.task_id);
      if (!t) return { ok: false, error: 'task_not_found' };
      if (t.status !== 'PENDING' && t.status !== 'ASSIGNED') {
        return { ok: false, error: 'invalid_transition', detail: 'from ' + t.status };
      }
      const updated = await housekeepingRepo.assignTask(ctx.tenantId, input.task_id, input.user_id);
      return { ok: true, result: { id: updated.id, status: updated.status, assigned_to: updated.assigned_to },
               events: [ makeEvent({ type: 'housekeeping.task_assigned', aggregateType: 'housekeeping_task',
                 aggregateId: updated.id,
                 payload: { assigned_to: updated.assigned_to }, ctx }) ]};
    }
  });

  // ---- pms.housekeeping.task.complete ---------------------------------
  cmds.push({
    name: 'pms.housekeeping.task.complete',
    aggregateType: 'housekeeping_task',
    permission: 'housekeeping.complete',
    async handler(input, ctx) {
      if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
      if (!input.task_id) return { ok: false, error: 'task_id_required' };
      const t = await housekeepingRepo.findTaskById(ctx.tenantId, input.task_id);
      if (!t) return { ok: false, error: 'task_not_found' };
      if (t.status === 'COMPLETED' || t.status === 'VERIFIED' || t.status === 'CANCELLED') {
        return { ok: false, error: 'invalid_transition', detail: 'from ' + t.status };
      }
      const updated = await housekeepingRepo.completeTask(ctx.tenantId, input.task_id, {
        verifiedBy: input.verified_by || null, notes: input.notes || null
      });
      return { ok: true, result: { id: updated.id, status: updated.status },
               events: [ makeEvent({ type: 'housekeeping.task_completed', aggregateType: 'housekeeping_task',
                 aggregateId: updated.id,
                 payload: { task_type: updated.task_type, room_id: updated.room_id }, ctx }) ]};
    }
  });

  return cmds;
}

module.exports = { makeCheckinFolioCommands };
