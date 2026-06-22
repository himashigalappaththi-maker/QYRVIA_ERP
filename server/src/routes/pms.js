'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');

/**
 * /api/pms/* surface.
 *
 * Every write -> commandBus.dispatch (which audits + persists events).
 * Every read  -> queryBus.execute    (which honours permission, no mutation).
 *
 * This file keeps routes thin: it shape-checks the URL surface and pumps
 * the body into the appropriate command/query name.
 */

function build({ commandBus, queryBus }) {
  const router = express.Router();
  if (!commandBus || !queryBus) return router;

  function call(commandName, mapInput) {
    return async function (req, res, next) {
      try {
        const input = mapInput ? mapInput(req) : (req.body || {});
        const outcome = await commandBus.dispatch(commandName, input, req.ctx);
        res.status(outcome.ok ? 200 : 400).json(Object.assign({ requestId: req.ctx.requestId }, outcome));
      } catch (err) { next(err); }
    };
  }
  function query(queryName, mapInput) {
    return async function (req, res, next) {
      try {
        const input = mapInput ? mapInput(req) : (Object.assign({}, req.query));
        const outcome = await queryBus.execute(queryName, input, req.ctx);
        res.status(outcome.ok ? 200 : 400).json(Object.assign({ requestId: req.ctx.requestId }, outcome));
      } catch (err) { next(err); }
    };
  }

  // --- Room Types ----------------------------------------------------------
  router.get(   '/room-types',           requirePermission('pms.roomtype.read'),  query('pms.roomtype.list'));
  router.get(   '/room-types/:id',       requirePermission('pms.roomtype.read'),  query('pms.roomtype.byId', (req) => ({ id: req.params.id })));
  router.post(  '/room-types',           requirePermission('pms.roomtype.write'), call('pms.roomtype.create'));

  // --- Buildings + Floors --------------------------------------------------
  router.post(  '/buildings',            requirePermission('pms.building.write'), call('pms.building.create'));
  router.post(  '/floors',               requirePermission('pms.building.write'), call('pms.floor.create'));

  // --- Rooms ---------------------------------------------------------------
  router.get(   '/rooms',                requirePermission('pms.room.read'),  query('pms.room.list'));
  router.get(   '/rooms/number/:number', requirePermission('pms.room.read'),  query('pms.room.byNumber', (req) => ({ room_number: req.params.number })));
  router.post(  '/rooms',                requirePermission('pms.room.write'), call('pms.room.create'));
  router.post(  '/rooms/:id/status',     requirePermission('pms.room.write'), call('pms.room.status.change',
    (req) => ({ room_id: req.params.id, status: (req.body || {}).status })));
  router.post(  '/rooms/:id/activate',   requirePermission('pms.room.write'), call('pms.room.activate',
    (req) => ({ room_id: req.params.id })));
  router.post(  '/rooms/:id/deactivate', requirePermission('pms.room.write'), call('pms.room.deactivate',
    (req) => ({ room_id: req.params.id })));

  // --- Room Features -------------------------------------------------------
  router.get(   '/room-features',                requirePermission('pms.feature.read'),  query('pms.feature.list'));
  router.post(  '/room-features',                requirePermission('pms.feature.write'), call('pms.feature.create'));
  router.post(  '/rooms/:id/features/:feature',  requirePermission('pms.feature.write'), call('pms.feature.attach',
    (req) => ({ room_id: req.params.id, feature_id: req.params.feature })));

  // --- Guests --------------------------------------------------------------
  router.get(   '/guests',               requirePermission('pms.guest.read'),  query('pms.guest.list'));
  router.get(   '/guests/:id',           requirePermission('pms.guest.read'),  query('pms.guest.byId', (req) => ({ id: req.params.id })));
  router.post(  '/guests',               requirePermission('pms.guest.write'), call('pms.guest.create'));
  router.post(  '/guests/:id/blacklist', requirePermission('pms.guest.write'), call('pms.guest.blacklist',
    (req) => ({ guest_id: req.params.id, blacklisted: (req.body && req.body.blacklisted) === false ? false : true })));

  // --- Child Policies ------------------------------------------------------
  router.get(   '/child-policies',       requirePermission('pms.childpolicy.read'),  query('pms.childpolicy.list'));
  router.get(   '/child-policies/:id',   requirePermission('pms.childpolicy.read'),  query('pms.childpolicy.byId', (req) => ({ id: req.params.id })));
  router.post(  '/child-policies',       requirePermission('pms.childpolicy.write'), call('pms.childpolicy.create'));

  // --- Reservations --------------------------------------------------------
  router.get(   '/reservations',                                requirePermission('pms.reservation.read'),  query('pms.reservation.list'));
  router.get(   '/reservations/number/:number',                 requirePermission('pms.reservation.read'),  query('pms.reservation.byNumber', (req) => ({ reservation_number: req.params.number })));
  router.post(  '/reservations',                                requirePermission('pms.reservation.write'), call('pms.reservation.create'));
  router.post(  '/reservations/:id/confirm',                    requirePermission('pms.reservation.write'), call('pms.reservation.confirm', (req) => ({ reservation_id: req.params.id })));
  router.post(  '/reservations/:id/cancel',                     requirePermission('pms.reservation.write'), call('pms.reservation.cancel',  (req) => ({ reservation_id: req.params.id, reason: (req.body||{}).reason })));
  router.post(  '/reservations/:id/no-show',                    requirePermission('pms.reservation.write'), call('pms.reservation.noShow',  (req) => ({ reservation_id: req.params.id })));

  // --- Rate Plans ----------------------------------------------------------
  router.get(   '/rate-plans',           requirePermission('pms.rateplan.read'),  query('pms.rateplan.list'));
  router.get(   '/rate-plans/:id',       requirePermission('pms.rateplan.read'),  query('pms.rateplan.byId', (req) => ({ id: req.params.id })));
  router.post(  '/rate-plans',           requirePermission('pms.rateplan.write'), call('pms.rateplan.create'));

  // --- Availability --------------------------------------------------------
  router.get(   '/availability',         requirePermission('pms.availability.read'), query('pms.availability.byDate'));
  router.get(   '/availability/calendar',requirePermission('pms.availability.read'), query('pms.availability.calendar'));

  // --- Check-In / Check-Out (Phase 5.5) -----------------------------------
  router.post(  '/reservations/:id/checkin',  requirePermission('pms.reservation.write'),
    call('pms.reservation.checkin',  (req) => ({ reservation_id: req.params.id,
                                                  assigned_room_id: (req.body||{}).assigned_room_id })));
  router.post(  '/reservations/:id/checkout', requirePermission('pms.reservation.write'),
    call('pms.reservation.checkout', (req) => ({ reservation_id: req.params.id,
                                                  force_close: !!(req.body||{}).force_close })));

  // --- Folio (Phase 5.5) --------------------------------------------------
  router.post(  '/folios/:id/charges',    requirePermission('folio.post'),
    call('pms.folio.charge.post', (req) => Object.assign({ folio_id: req.params.id }, req.body || {})));
  router.post(  '/folios/:id/close',      requirePermission('folio.close'),
    call('pms.folio.close',       (req) => ({ folio_id: req.params.id, force: !!(req.body||{}).force })));

  // --- Reservation Groups (Phase 7 / C5) ----------------------------------
  router.post(  '/reservation-groups',                  requirePermission('reservation.group.write'), call('pms.reservation_group.create'));
  router.get(   '/reservation-groups/:id',              requirePermission('pms.reservation.read'),    query('pms.reservation_group.byId', (req) => ({ id: req.params.id })));
  router.get(   '/reservation-groups/:id/rooming-list', requirePermission('pms.reservation.read'),    query('pms.reservation_group.rooming_list', (req) => ({ id: req.params.id })));
  router.post(  '/reservation-groups/:id/rooms',        requirePermission('reservation.group.write'), call('pms.reservation_group.add_room',
    (req) => ({ group_id: req.params.id, reservation_id: (req.body||{}).reservation_id })));
  router.post(  '/reservation-groups/:id/cancel-all',   requirePermission('reservation.group.write'), call('pms.reservation_group.cancel_all',
    (req) => ({ group_id: req.params.id, reason: (req.body||{}).reason, force: !!(req.body||{}).force })));
  router.post(  '/reservation-groups/:id/checkin-all',  requirePermission('reservation.group.write'), call('pms.reservation_group.checkin_all',
    (req) => ({ group_id: req.params.id })));

  // --- Vouchers (Phase 7 / C6) --------------------------------------------
  router.post(  '/vouchers',              requirePermission('voucher.write'),  call('pms.voucher.issue'));
  router.get(   '/vouchers/:n',           requirePermission('voucher.read'),   query('pms.voucher.byNumber', (req) => ({ voucher_number: req.params.n })));
  router.post(  '/vouchers/:n/redeem',    requirePermission('voucher.redeem'), call('pms.voucher.redeem',
    (req) => ({ voucher_number: req.params.n, reservation_id: (req.body||{}).reservation_id })));
  router.post(  '/vouchers/:n/cancel',    requirePermission('voucher.write'),  call('pms.voucher.cancel',
    (req) => ({ voucher_number: req.params.n, reason: (req.body||{}).reason })));

  // --- Invoices (Phase 7 / C9) --------------------------------------------
  router.get(   '/invoices',                requirePermission('invoice.read'),  query('pms.invoice.list'));
  router.get(   '/invoices/:id',            requirePermission('invoice.read'),  query('pms.invoice.byId', (req) => ({ id: req.params.id })));
  router.get(   '/invoices/number/:n',      requirePermission('invoice.read'),  query('pms.invoice.byNumber', (req) => ({ invoice_number: req.params.n })));
  router.post(  '/invoices/issue',          requirePermission('invoice.write'), call('pms.invoice.issue_from_folio'));
  router.post(  '/invoices/:id/void',       requirePermission('invoice.void'),  call('pms.invoice.void', (req) => ({ invoice_id: req.params.id, reason: (req.body||{}).reason })));

  // --- Cash payment (Phase 7 / C10) ---------------------------------------
  router.post(  '/folios/:id/payments/cash',  requirePermission('folio.post'),
    call('pms.folio.payment.cash', (req) => Object.assign({ folio_id: req.params.id }, req.body || {})));

  // --- Payment Allocation (Phase 7 / C8) ----------------------------------
  router.post(  '/folios/:id/payments/:pid/allocate', requirePermission('folio.post'),
    call('pms.folio.payment.allocate',
      (req) => Object.assign({ folio_id: req.params.id, payment_line_id: req.params.pid }, req.body || {})));
  router.get(   '/folios/:id/allocations',           requirePermission('folio.allocate.read'),
    query('pms.folio.allocations.list',
      (req) => ({ folio_id: req.params.id, payment_line_id: req.query.payment_line_id })));

  // --- Housekeeping (Phase 5.5) -------------------------------------------
  router.post(  '/housekeeping/tasks',                 requirePermission('housekeeping.assign'),
    call('pms.housekeeping.task.create'));
  router.post(  '/housekeeping/tasks/:id/assign',      requirePermission('housekeeping.assign'),
    call('pms.housekeeping.task.assign',   (req) => ({ task_id: req.params.id, user_id: (req.body||{}).user_id })));
  router.post(  '/housekeeping/tasks/:id/complete',    requirePermission('housekeeping.complete'),
    call('pms.housekeeping.task.complete', (req) => Object.assign({ task_id: req.params.id }, req.body || {})));

  // --- Night Audit (Phase 5.5) --------------------------------------------
  router.post(  '/night-audit/run',      requirePermission('night_audit.run'),
    call('pms.night_audit.run'));

  // --- Night Audit Scheduler (Phase 6 / C13) -----------------------------
  router.post(  '/night-audit/schedule', requirePermission('night_audit.config'),
    call('pms.night_audit.schedule'));

  // --- Meal Plans (Phase 6 / C4) ------------------------------------------
  router.get(   '/meal-plans',       requirePermission('pms.mealplan.read'),  query('pms.mealplan.list'));
  router.get(   '/meal-plans/:id',   requirePermission('pms.mealplan.read'),  query('pms.mealplan.byId', (req) => ({ id: req.params.id })));
  router.post(  '/meal-plans',       requirePermission('pms.mealplan.write'), call('pms.mealplan.create'));
  router.post(  '/rate-plans/:id/meal-plan', requirePermission('pms.mealplan.write'),
    call('pms.mealplan.attach_to_rateplan',
      (req) => ({ rate_plan_id: req.params.id, meal_plan_id: (req.body || {}).meal_plan_id })));

  return router;
}

module.exports = { build };
