'use strict';

/**
 * PMS query bundle.
 *
 *   const { makeQueries } = require('./queries/pms');
 *   const qs = makeQueries({ pmsRepo, availability });
 *   qs.forEach((q) => queryBus.register(q));
 *
 * Queries MUST NOT mutate. Each declares its permission code.
 * No fake data - every query hits the real repo and returns empty when
 * no data exists. Property isolation enforced by ctx.tenantId in repos.
 */

const availability = require('../../services/pms/availability');

function _strReq(v, name) { if (!v || typeof v !== 'string') throw new Error(name + ' required'); return v.trim(); }

function makeQueries({ pmsRepo, folioRepo, housekeepingRepo, nightAuditRepo }) {
  if (!pmsRepo) throw new Error('makeQueries: pmsRepo required');
  const list = [];
  const today = () => new Date().toISOString().slice(0, 10);

  list.push({
    name: 'pms.roomtype.list', resourceType: 'room_type', permission: 'pms.roomtype.read',
    async handler(input, ctx) {
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      return { ok: true, data: await pmsRepo.listRoomTypes(ctx.tenantId, ctx.propertyId) };
    }
  });
  list.push({
    name: 'pms.roomtype.byId', resourceType: 'room_type', permission: 'pms.roomtype.read',
    async handler(input, ctx) {
      if (!input.id) return { ok: false, error: 'id_required' };
      const row = await pmsRepo.findRoomTypeById(ctx.tenantId, input.id);
      return row ? { ok: true, data: row } : { ok: false, error: 'not_found' };
    }
  });
  list.push({
    name: 'pms.room.list', resourceType: 'room', permission: 'pms.room.read',
    async handler(input, ctx) {
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      const rows = await pmsRepo.listRooms(ctx.tenantId, ctx.propertyId, { activeOnly: !!input.active_only });
      return { ok: true, data: rows };
    }
  });
  list.push({
    name: 'pms.room.byNumber', resourceType: 'room', permission: 'pms.room.read',
    async handler(input, ctx) {
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      if (!input.room_number) return { ok: false, error: 'room_number_required' };
      const row = await pmsRepo.findRoomByNumber(ctx.tenantId, ctx.propertyId, input.room_number);
      return row ? { ok: true, data: row } : { ok: false, error: 'not_found' };
    }
  });
  list.push({
    name: 'pms.feature.list', resourceType: 'room_feature', permission: 'pms.feature.read',
    async handler(input, ctx) {
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      return { ok: true, data: await pmsRepo.listRoomFeatures(ctx.tenantId, ctx.propertyId) };
    }
  });
  list.push({
    name: 'pms.guest.list', resourceType: 'guest', permission: 'pms.guest.read',
    async handler(input, ctx) {
      return { ok: true, data: await pmsRepo.listGuests(ctx.tenantId, { guestType: input.guest_type, q: input.q }) };
    }
  });
  list.push({
    name: 'pms.guest.byId', resourceType: 'guest', permission: 'pms.guest.read',
    async handler(input, ctx) {
      if (!input.id) return { ok: false, error: 'id_required' };
      const row = await pmsRepo.findGuestById(ctx.tenantId, input.id);
      return row ? { ok: true, data: row } : { ok: false, error: 'not_found' };
    }
  });
  list.push({
    name: 'pms.childpolicy.list', resourceType: 'child_policy', permission: 'pms.childpolicy.read',
    async handler(input, ctx) {
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      return { ok: true, data: await pmsRepo.listChildPolicies(ctx.tenantId, ctx.propertyId) };
    }
  });
  list.push({
    name: 'pms.childpolicy.byId', resourceType: 'child_policy', permission: 'pms.childpolicy.read',
    async handler(input, ctx) {
      if (!input.id) return { ok: false, error: 'id_required' };
      const row = await pmsRepo.loadChildPolicyWithCategories(ctx.tenantId, input.id);
      return row ? { ok: true, data: row } : { ok: false, error: 'not_found' };
    }
  });
  list.push({
    name: 'pms.reservation.list', resourceType: 'reservation', permission: 'pms.reservation.read',
    async handler(input, ctx) {
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      return { ok: true, data: await pmsRepo.listReservations(ctx.tenantId, ctx.propertyId,
        { status: input.status, dateFrom: input.date_from, dateTo: input.date_to, source_channel: input.source_channel }) };
    }
  });
  list.push({
    name: 'pms.reservation.byNumber', resourceType: 'reservation', permission: 'pms.reservation.read',
    async handler(input, ctx) {
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      if (!input.reservation_number) return { ok: false, error: 'reservation_number_required' };
      const row = await pmsRepo.findReservationByNumber(ctx.tenantId, ctx.propertyId, input.reservation_number);
      return row ? { ok: true, data: row } : { ok: false, error: 'not_found' };
    }
  });
  list.push({
    name: 'pms.rateplan.list', resourceType: 'rate_plan', permission: 'pms.rateplan.read',
    async handler(input, ctx) {
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      return { ok: true, data: await pmsRepo.listRatePlans(ctx.tenantId, ctx.propertyId) };
    }
  });
  list.push({
    name: 'pms.rateplan.byId', resourceType: 'rate_plan', permission: 'pms.rateplan.read',
    async handler(input, ctx) {
      if (!input.id) return { ok: false, error: 'id_required' };
      const plan = await pmsRepo.findRatePlanById(ctx.tenantId, input.id);
      if (!plan) return { ok: false, error: 'not_found' };
      const periods = await pmsRepo.listRatePlanPeriods(ctx.tenantId, input.id);
      const pricing = await pmsRepo.listRatePlanPricing(ctx.tenantId, input.id);
      return { ok: true, data: Object.assign({}, plan, { periods, pricing }) };
    }
  });
  list.push({
    name: 'pms.availability.byDate', resourceType: 'availability', permission: 'pms.availability.read',
    async handler(input, ctx) {
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      if (!input.date) return { ok: false, error: 'date_required' };
      const data = await availability.roomsByDate(pmsRepo, {
        tenantId: ctx.tenantId, propertyId: ctx.propertyId, date: input.date, roomTypeId: input.room_type_id
      });
      return { ok: true, data };
    }
  });
  list.push({
    name: 'pms.availability.calendar', resourceType: 'availability', permission: 'pms.availability.read',
    async handler(input, ctx) {
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      if (!input.date_from || !input.date_to) return { ok: false, error: 'date_range_required' };
      const data = await availability.inventoryByRange(pmsRepo, {
        tenantId: ctx.tenantId, propertyId: ctx.propertyId,
        dateFrom: input.date_from, dateTo: input.date_to, roomTypeId: input.room_type_id
      });
      return { ok: true, data };
    }
  });

  // ---- payment allocations (Phase 7 / C8) -------------------------------
  if (folioRepo) {
    list.push({
      name: 'pms.folio.allocations.list', resourceType: 'folio', permission: 'folio.allocate.read',
      async handler(input, ctx) {
        if (!ctx.tenantId)   return { ok: false, error: 'tenant_required' };
        if (!input.folio_id) return { ok: false, error: 'folio_id_required' };
        const rows = input.payment_line_id
          ? await folioRepo.listAllocationsForPayment(ctx.tenantId, input.payment_line_id)
          : await folioRepo.listAllocationsForFolio(ctx.tenantId, input.folio_id);
        return { ok: true, data: rows };
      }
    });
  }

  // ---- invoices (Phase 7 / C9) ------------------------------------------
  if (folioRepo) {
    list.push({
      name: 'pms.invoice.list', resourceType: 'invoice', permission: 'invoice.read',
      async handler(input, ctx) {
        if (!ctx.propertyId) return { ok: false, error: 'property_required' };
        return { ok: true, data: await folioRepo.listInvoices(ctx.tenantId, ctx.propertyId, { status: input.status }) };
      }
    });
    list.push({
      name: 'pms.invoice.byId', resourceType: 'invoice', permission: 'invoice.read',
      async handler(input, ctx) {
        if (!input.id) return { ok: false, error: 'id_required' };
        const row = await folioRepo.findInvoiceById(ctx.tenantId, input.id);
        return row ? { ok: true, data: row } : { ok: false, error: 'not_found' };
      }
    });
    list.push({
      name: 'pms.invoice.byNumber', resourceType: 'invoice', permission: 'invoice.read',
      async handler(input, ctx) {
        if (!ctx.propertyId) return { ok: false, error: 'property_required' };
        if (!input.invoice_number) return { ok: false, error: 'invoice_number_required' };
        const row = await folioRepo.findInvoiceByNumber(ctx.tenantId, ctx.propertyId, input.invoice_number);
        return row ? { ok: true, data: row } : { ok: false, error: 'not_found' };
      }
    });
  }

  // ---- reservation groups (Phase 7 / C5) --------------------------------
  list.push({
    name: 'pms.reservation_group.byId', resourceType: 'reservation_group', permission: 'pms.reservation.read',
    async handler(input, ctx) {
      if (!input.id) return { ok: false, error: 'id_required' };
      const row = await pmsRepo.findReservationGroupById(ctx.tenantId, input.id);
      return row ? { ok: true, data: row } : { ok: false, error: 'not_found' };
    }
  });
  list.push({
    name: 'pms.reservation_group.rooming_list', resourceType: 'reservation_group', permission: 'pms.reservation.read',
    async handler(input, ctx) {
      if (!input.id) return { ok: false, error: 'id_required' };
      const rows = await pmsRepo.listReservationsInGroup(ctx.tenantId, input.id);
      return { ok: true, data: rows };
    }
  });

  // ---- vouchers (Phase 7 / C6) ------------------------------------------
  list.push({
    name: 'pms.voucher.byNumber', resourceType: 'voucher', permission: 'voucher.read',
    async handler(input, ctx) {
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      if (!input.voucher_number) return { ok: false, error: 'voucher_number_required' };
      const row = await pmsRepo.findVoucherByNumber(ctx.tenantId, ctx.propertyId, input.voucher_number);
      return row ? { ok: true, data: row } : { ok: false, error: 'not_found' };
    }
  });

  // ---- Front Desk lists (Phase 21: arrivals / departures / in-house) ----
  list.push({
    name: 'pms.frontdesk.arrivals', resourceType: 'reservation', permission: 'pms.reservation.read',
    async handler(input, ctx) {
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      const d = input.date || ctx.businessDate || today();
      const rows = await pmsRepo.listReservations(ctx.tenantId, ctx.propertyId, { status: 'CONFIRMED' });
      return { ok: true, data: rows.filter((r) => String(r.arrival_date).slice(0, 10) <= d) };
    }
  });
  list.push({
    name: 'pms.frontdesk.departures', resourceType: 'reservation', permission: 'pms.reservation.read',
    async handler(input, ctx) {
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      const d = input.date || ctx.businessDate || today();
      const rows = await pmsRepo.listReservations(ctx.tenantId, ctx.propertyId, { status: 'CHECKED_IN' });
      return { ok: true, data: rows.filter((r) => String(r.departure_date).slice(0, 10) <= d) };
    }
  });
  list.push({
    name: 'pms.frontdesk.inhouse', resourceType: 'reservation', permission: 'pms.reservation.read',
    async handler(input, ctx) {
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      const rows = await pmsRepo.listReservations(ctx.tenantId, ctx.propertyId, { status: 'CHECKED_IN' });
      return { ok: true, data: rows };
    }
  });

  // ---- Folio reads (Phase 21) ------------------------------------------
  if (folioRepo) {
    list.push({
      name: 'pms.folio.list', resourceType: 'folio', permission: 'folio.read',
      async handler(input, ctx) {
        if (!ctx.propertyId) return { ok: false, error: 'property_required' };
        return { ok: true, data: await folioRepo.listFolios(ctx.tenantId, ctx.propertyId,
          { status: input.status, reservation_id: input.reservation_id }) };
      }
    });
    list.push({
      name: 'pms.folio.byId', resourceType: 'folio', permission: 'folio.read',
      async handler(input, ctx) {
        if (!input.id) return { ok: false, error: 'id_required' };
        const folio = await folioRepo.findFolioById(ctx.tenantId, input.id);
        if (!folio) return { ok: false, error: 'not_found' };
        const lines = await folioRepo.listFolioLines(ctx.tenantId, folio.id);
        return { ok: true, data: Object.assign({}, folio, { lines }) };
      }
    });
  }

  // ---- Housekeeping reads (Phase 21) -----------------------------------
  if (housekeepingRepo) {
    list.push({
      name: 'pms.housekeeping.task.list', resourceType: 'housekeeping_task', permission: 'housekeeping.read',
      async handler(input, ctx) {
        if (!ctx.propertyId) return { ok: false, error: 'property_required' };
        return { ok: true, data: await housekeepingRepo.listTasks(ctx.tenantId, ctx.propertyId,
          { status: input.status, assigned_to: input.assigned_to }) };
      }
    });
    list.push({
      name: 'pms.housekeeping.room_status', resourceType: 'room', permission: 'housekeeping.read',
      async handler(input, ctx) {
        if (!ctx.propertyId) return { ok: false, error: 'property_required' };
        return { ok: true, data: await pmsRepo.listRooms(ctx.tenantId, ctx.propertyId, { activeOnly: !!input.active_only }) };
      }
    });
  }

  // ---- Night Audit reads (Phase 21) ------------------------------------
  if (nightAuditRepo) {
    list.push({
      name: 'pms.night_audit.status', resourceType: 'night_audit', permission: 'night_audit.read',
      async handler(input, ctx) {
        if (!ctx.propertyId) return { ok: false, error: 'property_required' };
        const latest = await nightAuditRepo.findLatestRun(ctx.tenantId, ctx.propertyId);
        const prop = await pmsRepo.findPropertyById(ctx.tenantId, ctx.propertyId);
        return { ok: true, data: {
          latest_run: latest || null,
          state: (latest && latest.status) || 'NONE',
          business_date: prop ? (prop.current_business_date || null) : null,
          business_date_locked: prop ? !!prop.business_date_locked : false
        } };
      }
    });
    list.push({
      name: 'pms.night_audit.history', resourceType: 'night_audit', permission: 'night_audit.read',
      async handler(input, ctx) {
        if (!ctx.propertyId) return { ok: false, error: 'property_required' };
        return { ok: true, data: await nightAuditRepo.listRuns(ctx.tenantId, ctx.propertyId, input.limit) };
      }
    });
  }

  // ---- meal plans (Phase 6 / C4) ---------------------------------------
  list.push({
    name: 'pms.mealplan.list', resourceType: 'meal_plan', permission: 'pms.mealplan.read',
    async handler(input, ctx) {
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      return { ok: true, data: await pmsRepo.listMealPlans(ctx.tenantId, ctx.propertyId) };
    }
  });
  list.push({
    name: 'pms.mealplan.byId', resourceType: 'meal_plan', permission: 'pms.mealplan.read',
    async handler(input, ctx) {
      if (!input.id) return { ok: false, error: 'id_required' };
      const row = await pmsRepo.findMealPlanById(ctx.tenantId, input.id);
      return row ? { ok: true, data: row } : { ok: false, error: 'not_found' };
    }
  });

  return list;
}

module.exports = { makeQueries };
