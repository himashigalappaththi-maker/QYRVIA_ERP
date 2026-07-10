'use strict';

/**
 * PMS command bundle.
 *
 *   const { makeCommands } = require('./commands/pms');
 *   const cmds = makeCommands({ pmsRepo });
 *   cmds.forEach((c) => commandBus.register(c));
 *
 * Every command:
 *   - takes (input, ctx)
 *   - returns { ok, result?, events?, error?, detail? }
 *   - declares the permission it requires; bus enforces super_admin bypass
 *   - rejects without ctx.propertyId where the action is property-scoped
 *   - emits domain events through ctx (which goes to audit + event_store)
 *
 * No fake data. No mock workflows. Every write hits the real repo.
 */

const { makeEvent } = require('../../core/event');
const { classifyParty } = require('../../services/pms/childPolicy');
const { nextReservationNumber } = require('../../services/pms/reservationNumber');
const { generateConfirmationNumber } = require('../../services/pms/confirmationNumber');

function _strReq(v, name, max) { if (!v || typeof v !== 'string') throw new Error(name + ' required'); if (max && v.length > max) throw new Error(name + ' too long'); return v.trim(); }
function _intMin(v, name, min) { if (!Number.isInteger(v) || v < min) throw new Error(name + ' must be integer >= ' + min); return v; }
function _need(ctxField, ctx) { if (!ctx || !ctx[ctxField]) throw new Error(ctxField + ' required'); }

function makeCommands({ pmsRepo }) {
  if (!pmsRepo) throw new Error('makeCommands: pmsRepo required');
  const list = [];

  // -- pms.building.create -----------------------------------------------
  list.push({
    name: 'pms.building.create',
    aggregateType: 'building',
    permission: 'pms.building.write',
    async handler(input, ctx) {
      _need('tenantId', ctx); _need('propertyId', ctx);
      try {
        const code = _strReq(input.code, 'code', 40);
        const name = _strReq(input.name, 'name', 200);
        const row  = await pmsRepo.insertBuilding({
          tenant_id: ctx.tenantId, property_id: ctx.propertyId,
          code, name, active: input.active !== false, created_by: ctx.actorId
        });
        return { ok: true, result: { id: row.id }, events: [
          makeEvent({ type: 'building.created', aggregateType: 'building', aggregateId: row.id,
            payload: { code, name, property_id: ctx.propertyId }, ctx })
        ]};
      } catch (e) { return { ok: false, error: 'validation_failed', detail: e.message }; }
    }
  });

  // -- pms.floor.create --------------------------------------------------
  list.push({
    name: 'pms.floor.create',
    aggregateType: 'floor',
    permission: 'pms.building.write',
    async handler(input, ctx) {
      _need('tenantId', ctx); _need('propertyId', ctx);
      try {
        const buildingId = _strReq(input.building_id, 'building_id', 64);
        const row = await pmsRepo.insertFloor({
          tenant_id: ctx.tenantId, property_id: ctx.propertyId, building_id: buildingId,
          code: _strReq(input.code, 'code', 40), name: _strReq(input.name, 'name', 120),
          active: input.active !== false
        });
        return { ok: true, result: { id: row.id }, events: [
          makeEvent({ type: 'floor.created', aggregateType: 'floor', aggregateId: row.id,
            payload: { code: row.code, building_id: buildingId, property_id: ctx.propertyId }, ctx })
        ]};
      } catch (e) { return { ok: false, error: 'validation_failed', detail: e.message }; }
    }
  });

  // -- pms.roomtype.create -----------------------------------------------
  list.push({
    name: 'pms.roomtype.create',
    aggregateType: 'room_type',
    permission: 'pms.roomtype.write',
    async handler(input, ctx) {
      _need('tenantId', ctx); _need('propertyId', ctx);
      try {
        const row = await pmsRepo.insertRoomType({
          tenant_id: ctx.tenantId, property_id: ctx.propertyId,
          code: _strReq(input.code, 'code', 40),
          name: _strReq(input.name, 'name', 200),
          description: input.description || null,
          max_adults:         _intMin(input.max_adults ?? 2, 'max_adults', 1),
          max_children:       _intMin(input.max_children ?? 0, 'max_children', 0),
          base_occupancy:     _intMin(input.base_occupancy ?? 2, 'base_occupancy', 1),
          extra_bed_capacity: _intMin(input.extra_bed_capacity ?? 0, 'extra_bed_capacity', 0),
          active: input.active !== false,
          created_by: ctx.actorId
        });
        return { ok: true, result: { id: row.id }, events: [
          makeEvent({ type: 'room_type.created', aggregateType: 'room_type', aggregateId: row.id,
            payload: { code: row.code, property_id: ctx.propertyId, base_occupancy: row.base_occupancy }, ctx })
        ]};
      } catch (e) { return { ok: false, error: 'validation_failed', detail: e.message }; }
    }
  });

  // -- pms.room.create ---------------------------------------------------
  list.push({
    name: 'pms.room.create',
    aggregateType: 'room',
    permission: 'pms.room.write',
    async handler(input, ctx) {
      _need('tenantId', ctx); _need('propertyId', ctx);
      try {
        const roomTypeId = _strReq(input.room_type_id, 'room_type_id', 64);
        // Validate type exists and belongs to this tenant
        const rt = await pmsRepo.findRoomTypeById(ctx.tenantId, roomTypeId);
        if (!rt || rt.property_id !== ctx.propertyId) return { ok: false, error: 'room_type_not_found' };
        const number = _strReq(input.room_number, 'room_number', 40);
        const row = await pmsRepo.insertRoom({
          tenant_id: ctx.tenantId, property_id: ctx.propertyId,
          building_id: input.building_id || null, floor_id: input.floor_id || null,
          room_type_id: roomTypeId,
          room_number: number, room_name: input.room_name || null,
          status: input.status || 'VACANT_CLEAN',
          active: input.active !== false, created_by: ctx.actorId
        });
        return { ok: true, result: { id: row.id }, events: [
          makeEvent({ type: 'room.created', aggregateType: 'room', aggregateId: row.id,
            payload: { room_number: number, room_type_id: roomTypeId, property_id: ctx.propertyId }, ctx })
        ]};
      } catch (e) { return { ok: false, error: 'validation_failed', detail: e.message }; }
    }
  });

  // -- pms.room.status.change --------------------------------------------
  list.push({
    name: 'pms.room.status.change',
    aggregateType: 'room',
    permission: 'pms.room.write',
    async handler(input, ctx) {
      _need('tenantId', ctx);
      const ALLOWED = ['VACANT_CLEAN','VACANT_DIRTY','OCCUPIED','OUT_OF_ORDER','OUT_OF_SERVICE','INSPECTED','BLOCKED'];
      if (!input.room_id) return { ok: false, error: 'room_id_required' };
      if (!ALLOWED.includes(input.status)) return { ok: false, error: 'invalid_status' };
      const before = await pmsRepo.findRoomById(ctx.tenantId, input.room_id);
      if (!before) return { ok: false, error: 'room_not_found' };
      const fromStatus = before.status;        // snapshot before mutation
      const updated = await pmsRepo.updateRoomStatus(ctx.tenantId, input.room_id, input.status);
      return { ok: true, result: { id: updated.id, status: updated.status }, events: [
        makeEvent({ type: 'room.status_changed', aggregateType: 'room', aggregateId: updated.id,
          payload: { from: fromStatus, to: updated.status, room_number: updated.room_number }, ctx })
      ]};
    }
  });

  // -- pms.room.activate / deactivate ------------------------------------
  list.push({
    name: 'pms.room.activate',
    aggregateType: 'room',
    permission: 'pms.room.write',
    async handler(input, ctx) {
      _need('tenantId', ctx);
      if (!input.room_id) return { ok: false, error: 'room_id_required' };
      const r = await pmsRepo.setRoomActive(ctx.tenantId, input.room_id, true);
      if (!r) return { ok: false, error: 'room_not_found' };
      return { ok: true, result: { id: r.id }, events: [
        makeEvent({ type: 'room.activated', aggregateType: 'room', aggregateId: r.id, payload: {}, ctx })
      ]};
    }
  });
  list.push({
    name: 'pms.room.deactivate',
    aggregateType: 'room',
    permission: 'pms.room.write',
    async handler(input, ctx) {
      _need('tenantId', ctx);
      if (!input.room_id) return { ok: false, error: 'room_id_required' };
      const r = await pmsRepo.setRoomActive(ctx.tenantId, input.room_id, false);
      if (!r) return { ok: false, error: 'room_not_found' };
      return { ok: true, result: { id: r.id }, events: [
        makeEvent({ type: 'room.deactivated', aggregateType: 'room', aggregateId: r.id, payload: {}, ctx })
      ]};
    }
  });

  // -- pms.feature.create ------------------------------------------------
  list.push({
    name: 'pms.feature.create',
    aggregateType: 'room_feature',
    permission: 'pms.feature.write',
    async handler(input, ctx) {
      _need('tenantId', ctx); _need('propertyId', ctx);
      try {
        const row = await pmsRepo.insertRoomFeature({
          tenant_id: ctx.tenantId, property_id: ctx.propertyId,
          code: _strReq(input.code, 'code', 40), name: _strReq(input.name, 'name', 200),
          active: input.active !== false
        });
        return { ok: true, result: { id: row.id }, events: [
          makeEvent({ type: 'room_feature.created', aggregateType: 'room_feature', aggregateId: row.id,
            payload: { code: row.code, name: row.name }, ctx })
        ]};
      } catch (e) { return { ok: false, error: 'validation_failed', detail: e.message }; }
    }
  });
  list.push({
    name: 'pms.feature.attach',
    aggregateType: 'room',
    permission: 'pms.feature.write',
    async handler(input, ctx) {
      _need('tenantId', ctx);
      if (!input.room_id || !input.feature_id) return { ok: false, error: 'room_id_and_feature_id_required' };
      await pmsRepo.attachRoomFeature(ctx.tenantId, input.room_id, input.feature_id);
      return { ok: true, result: { room_id: input.room_id, feature_id: input.feature_id }, events: [
        makeEvent({ type: 'room_feature.attached', aggregateType: 'room', aggregateId: input.room_id,
          payload: { feature_id: input.feature_id }, ctx })
      ]};
    }
  });

  // -- pms.guest.create --------------------------------------------------
  const GUEST_TYPES = ['INDIVIDUAL','CORPORATE','TRAVEL_AGENT','DMC','TOUR_ORGANIZER'];
  list.push({
    name: 'pms.guest.create',
    aggregateType: 'guest',
    permission: 'pms.guest.write',
    async handler(input, ctx) {
      _need('tenantId', ctx);
      try {
        const gtype = input.guest_type || 'INDIVIDUAL';
        if (!GUEST_TYPES.includes(gtype)) return { ok: false, error: 'invalid_guest_type' };
        const first = _strReq(input.first_name, 'first_name', 120);
        const row = await pmsRepo.insertGuest({
          tenant_id: ctx.tenantId, property_id: ctx.propertyId || null,
          guest_type: gtype, title: input.title || null,
          first_name: first, last_name: input.last_name || null,
          gender: input.gender || null, dob: input.dob || null,
          nationality: input.nationality || null, language: input.language || null,
          email: input.email || null, mobile: input.mobile || null,
          address: input.address || null,
          passport_number: input.passport_number || null, national_id: input.national_id || null,
          organization_name: input.organization_name || null, tax_id: input.tax_id || null,
          vip_flag: !!input.vip_flag, blacklisted_flag: !!input.blacklisted_flag,
          notes: input.notes || null, created_by: ctx.actorId
        });
        return { ok: true, result: { id: row.id }, events: [
          makeEvent({ type: 'guest.created', aggregateType: 'guest', aggregateId: row.id,
            payload: { guest_type: gtype, first_name: first, last_name: input.last_name || null }, ctx })
        ]};
      } catch (e) { return { ok: false, error: 'validation_failed', detail: e.message }; }
    }
  });
  list.push({
    name: 'pms.guest.blacklist',
    aggregateType: 'guest',
    permission: 'pms.guest.write',
    async handler(input, ctx) {
      _need('tenantId', ctx);
      if (!input.guest_id) return { ok: false, error: 'guest_id_required' };
      const r = await pmsRepo.updateGuestFlags(ctx.tenantId, input.guest_id, { blacklisted_flag: !!input.blacklisted });
      if (!r) return { ok: false, error: 'guest_not_found' };
      return { ok: true, result: { id: r.id, blacklisted_flag: r.blacklisted_flag }, events: [
        makeEvent({ type: 'guest.blacklist_updated', aggregateType: 'guest', aggregateId: r.id,
          payload: { blacklisted_flag: r.blacklisted_flag }, ctx })
      ]};
    }
  });

  // -- pms.childpolicy.create --------------------------------------------
  list.push({
    name: 'pms.childpolicy.create',
    aggregateType: 'child_policy',
    permission: 'pms.childpolicy.write',
    async handler(input, ctx) {
      _need('tenantId', ctx); _need('propertyId', ctx);
      try {
        const code = _strReq(input.code, 'code', 40);
        const name = _strReq(input.name, 'name', 200);
        const cats = Array.isArray(input.categories) ? input.categories : [];
        const row = await pmsRepo.insertChildPolicy({
          tenant_id: ctx.tenantId, property_id: ctx.propertyId,
          code, name, description: input.description || null, active: input.active !== false,
          created_by: ctx.actorId
        });
        for (const c of cats) {
          await pmsRepo.insertChildAgeCategory({
            tenant_id: ctx.tenantId, child_policy_id: row.id,
            code: _strReq(c.code, 'category.code', 40),
            name: _strReq(c.name, 'category.name', 120),
            age_from: _intMin(c.age_from, 'age_from', 0),
            age_to:   _intMin(c.age_to,   'age_to',   c.age_from),
            stay_charge_pct: c.stay_charge_pct || 0,
            meal_charge_pct: c.meal_charge_pct || 0,
            counts_in_occupancy: !!c.counts_in_occupancy,
            requires_extra_bed:  !!c.requires_extra_bed,
            extra_bed_charge:    c.extra_bed_charge || 0
          });
        }
        return { ok: true, result: { id: row.id, categories: cats.length }, events: [
          makeEvent({ type: 'child_policy.created', aggregateType: 'child_policy', aggregateId: row.id,
            payload: { code, categories: cats.length }, ctx })
        ]};
      } catch (e) { return { ok: false, error: 'validation_failed', detail: e.message }; }
    }
  });

  // -- pms.rateplan.create -----------------------------------------------
  list.push({
    name: 'pms.rateplan.create',
    aggregateType: 'rate_plan',
    permission: 'pms.rateplan.write',
    async handler(input, ctx) {
      _need('tenantId', ctx); _need('propertyId', ctx);
      try {
        const row = await pmsRepo.insertRatePlan({
          tenant_id: ctx.tenantId, property_id: ctx.propertyId,
          code: _strReq(input.code, 'code', 40),
          name: _strReq(input.name, 'name', 200),
          description: input.description || null,
          currency: input.currency || 'LKR',
          base_rate: input.base_rate || 0,
          active: input.active !== false, created_by: ctx.actorId
        });
        // Optional bundled periods + pricing rows
        for (const p of (input.periods || [])) {
          await pmsRepo.insertRatePlanPeriod({
            tenant_id: ctx.tenantId, rate_plan_id: row.id,
            name: p.name || null, date_from: p.date_from, date_to: p.date_to, rate: p.rate
          });
        }
        for (const pr of (input.pricing || [])) {
          await pmsRepo.insertRatePlanPricing({
            tenant_id: ctx.tenantId, rate_plan_id: row.id,
            pricing_type: pr.pricing_type, occupancy_count: pr.occupancy_count,
            child_category_code: pr.child_category_code, rate: pr.rate, rate_pct: pr.rate_pct
          });
        }
        return { ok: true, result: { id: row.id }, events: [
          makeEvent({ type: 'rate_plan.created', aggregateType: 'rate_plan', aggregateId: row.id,
            payload: { code: row.code, base_rate: row.base_rate, periods: (input.periods||[]).length }, ctx })
        ]};
      } catch (e) { return { ok: false, error: 'validation_failed', detail: e.message }; }
    }
  });

  // -- pms.reservation.create --------------------------------------------
  list.push({
    name: 'pms.reservation.create',
    aggregateType: 'reservation',
    permission: 'pms.reservation.write',
    async handler(input, ctx) {
      _need('tenantId', ctx); _need('propertyId', ctx);
      try {
        // Holder validation: must be an Adult/Company/Agent/DMC/Tour - i.e.
        // any of the guest_type values. A child is NEVER a holder. We do
        // not have an explicit "is_child" flag on guests; child enforcement
        // happens by requiring holder.guest_type IN the supported set,
        // and the brief states children are entered via the `children` count
        // and child policy categories - never as the holder.
        const holderId = _strReq(input.holder_guest_id, 'holder_guest_id', 64);
        const primaryAdultId = _strReq(input.primary_adult_guest_id, 'primary_adult_guest_id', 64);
        const holder = await pmsRepo.findGuestById(ctx.tenantId, holderId);
        if (!holder) return { ok: false, error: 'holder_not_found' };
        if (holder.blacklisted_flag) return { ok: false, error: 'holder_blacklisted' };
        const adult = await pmsRepo.findGuestById(ctx.tenantId, primaryAdultId);
        if (!adult) return { ok: false, error: 'primary_adult_not_found' };

        const roomTypeId = _strReq(input.room_type_id, 'room_type_id', 64);
        const roomType   = await pmsRepo.findRoomTypeById(ctx.tenantId, roomTypeId);
        if (!roomType || roomType.property_id !== ctx.propertyId) return { ok: false, error: 'room_type_not_found' };

        const adults   = _intMin(input.adults ?? 1, 'adults', 1);
        const children = _intMin(input.children ?? 0, 'children', 0);
        const arrival   = _strReq(input.arrival_date,   'arrival_date',   10);
        const departure = _strReq(input.departure_date, 'departure_date', 10);
        if (departure <= arrival) return { ok: false, error: 'invalid_date_range' };

        // Soft capacity check if child policy is supplied
        if (input.child_policy_id && children > 0) {
          const policy = await pmsRepo.loadChildPolicyWithCategories(ctx.tenantId, input.child_policy_id);
          if (!policy) return { ok: false, error: 'child_policy_not_found' };
          const cls = classifyParty({
            adults, children: input.child_ages || [], policy,
            roomType: { max_adults: roomType.max_adults, max_children: roomType.max_children,
                        base_occupancy: roomType.base_occupancy, extra_bed_capacity: roomType.extra_bed_capacity }
          });
          if (cls.oversold) return { ok: false, error: 'capacity_exceeded', detail: cls.reasons.join(',') };
        }

        // Reservation number
        const property = await pmsRepo.findPropertyById(ctx.tenantId, ctx.propertyId);
        if (!property) return { ok: false, error: 'property_not_found' };
        const { number, sequence, year } = await nextReservationNumber(pmsRepo, {
          tenantId: ctx.tenantId, propertyId: ctx.propertyId, propertyCode: property.code,
          year: input.year || new Date(arrival).getUTCFullYear()
        });

        const rtype = input.reservation_type || 'INDIVIDUAL';

        const row = await pmsRepo.insertReservation({
          tenant_id: ctx.tenantId, property_id: ctx.propertyId,
          reservation_number: number,
          reservation_type: rtype, status: 'INQUIRY',
          holder_guest_id: holderId, primary_adult_guest_id: primaryAdultId,
          arrival_date: arrival, departure_date: departure,
          adults, children, room_type_id: roomTypeId,
          rate_plan_id: input.rate_plan_id || null,
          rooms_count: input.rooms_count || 1,
          notes: input.notes || null,
          business_date: ctx.businessDate || null,
          created_by: ctx.actorId,
          allocation_id: input.allocation_id || null,
          contract_id: input.contract_id || null,
          group_id: input.group_id || null,
          idempotency_key: input.idempotency_key || null,
        });

        return { ok: true, result: { id: row.id, reservation_number: number, sequence, year }, events: [
          makeEvent({ type: 'reservation.created', aggregateType: 'reservation', aggregateId: row.id,
            payload: { reservation_number: number, reservation_type: rtype, status: 'INQUIRY',
                       holder_guest_id: holderId, room_type_id: roomTypeId,
                       arrival_date: arrival, departure_date: departure, adults, children,
                       allocation_id: input.allocation_id || null,
                       contract_id:  input.contract_id  || null,
                       group_id:     input.group_id     || null }, ctx })
        ]};
      } catch (e) { return { ok: false, error: 'validation_failed', detail: e.message }; }
    }
  });

  // -- pms.reservation.confirm / cancel / no_show ------------------------
  function transitionCmd(name, eventType, newStatus, opts) {
    return {
      name, aggregateType: 'reservation', permission: 'pms.reservation.write',
      async handler(input, ctx) {
        _need('tenantId', ctx);
        if (!input.reservation_id) return { ok: false, error: 'reservation_id_required' };
        const before = await pmsRepo.findReservationById(ctx.tenantId, input.reservation_id);
        if (!before) return { ok: false, error: 'reservation_not_found' };
        const fromStatus = before.status;       // snapshot before mutation (fakes share refs)
        if (opts && opts.requireFrom && !opts.requireFrom.includes(fromStatus)) {
          return { ok: false, error: 'invalid_transition', detail: 'from ' + fromStatus };
        }
        const updated = await pmsRepo.setReservationStatus(ctx.tenantId, input.reservation_id, newStatus, {
          cancellationReason: input.reason || null
        });
        return { ok: true, result: { id: updated.id, status: updated.status }, events: [
          makeEvent({ type: eventType, aggregateType: 'reservation', aggregateId: updated.id,
            payload: { reservation_number: updated.reservation_number,
                       from: fromStatus, to: updated.status,
                       reason: input.reason || null,
                       allocation_id: updated.allocation_id || null,
                       group_id: updated.group_id || null }, ctx })
        ]};
      }
    };
  }

  // pms.reservation.confirm is extracted from transitionCmd so it can generate
  // and persist a confirmation_number at transition time.
  list.push({
    name: 'pms.reservation.confirm',
    aggregateType: 'reservation',
    permission: 'pms.reservation.write',
    async handler(input, ctx) {
      _need('tenantId', ctx);
      if (!input.reservation_id) return { ok: false, error: 'reservation_id_required' };
      const before = await pmsRepo.findReservationById(ctx.tenantId, input.reservation_id);
      if (!before) return { ok: false, error: 'reservation_not_found' };
      const fromStatus = before.status;
      if (!['INQUIRY', 'OPTION'].includes(fromStatus)) {
        return { ok: false, error: 'invalid_transition', detail: 'from ' + fromStatus };
      }
      const updated = await pmsRepo.setReservationStatus(ctx.tenantId, input.reservation_id, 'CONFIRMED', {});
      // Generate confirmation_number if not already set (first confirm wins).
      const confirmationNumber = before.confirmation_number || generateConfirmationNumber(before.id);
      if (confirmationNumber && pmsRepo.setReservationConfirmation) {
        try {
          await pmsRepo.setReservationConfirmation(ctx.tenantId, input.reservation_id, { confirmationNumber });
        } catch (cnErr) {
          try { require('../../config/logger').warn({ err: cnErr }, '[pms.confirm] setReservationConfirmation failed — non-blocking'); } catch (_) {}
        }
      }
      return { ok: true, result: { id: updated.id, status: updated.status, confirmation_number: confirmationNumber }, events: [
        makeEvent({ type: 'reservation.confirmed', aggregateType: 'reservation', aggregateId: updated.id,
          payload: { reservation_number: updated.reservation_number,
                     from: fromStatus, to: updated.status,
                     confirmation_number: confirmationNumber,
                     group_id: updated.group_id || null }, ctx })
      ]};
    }
  });
  list.push(transitionCmd('pms.reservation.cancel',  'reservation.cancelled', 'CANCELLED', { requireFrom: ['INQUIRY','OPTION','CONFIRMED'] }));
  list.push(transitionCmd('pms.reservation.noShow',  'reservation.no_show',   'NO_SHOW',   { requireFrom: ['CONFIRMED'] }));

  // -- pms.reservation.update (Phase 21: edit a pre-stay booking) ----------
  list.push({
    name: 'pms.reservation.update',
    aggregateType: 'reservation',
    permission: 'pms.reservation.write',
    async handler(input, ctx) {
      _need('tenantId', ctx);
      if (!input.reservation_id) return { ok: false, error: 'reservation_id_required' };
      const before = await pmsRepo.findReservationById(ctx.tenantId, input.reservation_id);
      if (!before) return { ok: false, error: 'reservation_not_found' };
      // Only mutable before check-in; prevents editing an in-house/closed stay.
      if (!['INQUIRY', 'OPTION', 'CONFIRMED'].includes(before.status)) {
        return { ok: false, error: 'invalid_state', detail: 'cannot edit a ' + before.status + ' reservation' };
      }
      try {
        const fields = {};
        if (input.reservation_type !== undefined) fields.reservation_type = input.reservation_type;
        if (input.notes !== undefined) fields.notes = input.notes;
        if (input.adults !== undefined) fields.adults = _intMin(input.adults, 'adults', 1);
        if (input.children !== undefined) fields.children = _intMin(input.children, 'children', 0);
        if (input.rooms_count !== undefined) fields.rooms_count = _intMin(input.rooms_count, 'rooms_count', 1);
        if (input.rate_plan_id !== undefined) fields.rate_plan_id = input.rate_plan_id || null;
        if (input.arrival_date !== undefined) fields.arrival_date = _strReq(input.arrival_date, 'arrival_date', 10);
        if (input.departure_date !== undefined) fields.departure_date = _strReq(input.departure_date, 'departure_date', 10);
        const arrival = fields.arrival_date || before.arrival_date;
        const departure = fields.departure_date || before.departure_date;
        if (String(departure) <= String(arrival)) return { ok: false, error: 'invalid_date_range' };
        if (input.room_type_id !== undefined && input.room_type_id) {
          const rt = await pmsRepo.findRoomTypeById(ctx.tenantId, input.room_type_id);
          if (!rt || rt.property_id !== before.property_id) return { ok: false, error: 'room_type_not_found' };
          fields.room_type_id = input.room_type_id;
        }
        const updated = await pmsRepo.updateReservation(ctx.tenantId, input.reservation_id, fields);
        return { ok: true, result: { id: updated.id, status: updated.status }, events: [
          makeEvent({ type: 'reservation.updated', aggregateType: 'reservation', aggregateId: updated.id,
            payload: { reservation_number: updated.reservation_number, changed: Object.keys(fields),
                       arrival_date: updated.arrival_date, departure_date: updated.departure_date,
                       property_id: before.property_id }, ctx })
        ]};
      } catch (e) { return { ok: false, error: 'validation_failed', detail: e.message }; }
    }
  });

  // -- pms.reservation.room_move (Phase 21: move an in-house guest) --------
  list.push({
    name: 'pms.reservation.room_move',
    aggregateType: 'reservation',
    permission: 'pms.reservation.write',
    async handler(input, ctx) {
      _need('tenantId', ctx);
      if (!input.reservation_id) return { ok: false, error: 'reservation_id_required' };
      if (!input.new_room_id) return { ok: false, error: 'new_room_id_required' };
      const before = await pmsRepo.findReservationById(ctx.tenantId, input.reservation_id);
      if (!before) return { ok: false, error: 'reservation_not_found' };
      if (before.status !== 'CHECKED_IN') return { ok: false, error: 'invalid_state', detail: 'room move requires CHECKED_IN' };
      const fromRoomId = before.assigned_room_id || null;
      if (input.new_room_id === fromRoomId) return { ok: false, error: 'same_room' };
      const room = await pmsRepo.findRoomById(ctx.tenantId, input.new_room_id);
      if (!room || room.property_id !== before.property_id) return { ok: false, error: 'room_not_found' };
      if (String(room.status).toUpperCase() === 'OCCUPIED') return { ok: false, error: 'room_occupied' };

      // Free the previous room for housekeeping, then occupy + reassign the new one.
      if (fromRoomId) await pmsRepo.updateRoomStatus(ctx.tenantId, fromRoomId, 'VACANT_DIRTY');
      const updated = await pmsRepo.reassignReservationRoom(ctx.tenantId, input.reservation_id, input.new_room_id);

      return { ok: true, result: { id: updated.id, assigned_room_id: updated.assigned_room_id, from_room_id: fromRoomId }, events: [
        makeEvent({ type: 'reservation.room_moved', aggregateType: 'reservation', aggregateId: updated.id,
          payload: { reservation_number: updated.reservation_number, from_room_id: fromRoomId,
                     to_room_id: input.new_room_id, property_id: before.property_id }, ctx }),
        makeEvent({ type: 'room.status_changed', aggregateType: 'room', aggregateId: input.new_room_id,
          payload: { to: 'OCCUPIED', reservation_id: updated.id, reason: 'room_move' }, ctx })
      ]};
    }
  });

  return list;
}

module.exports = { makeCommands };
