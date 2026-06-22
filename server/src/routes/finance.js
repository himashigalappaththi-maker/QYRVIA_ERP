'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');

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

  // ---- Cost Centers (Phase 8 / C11) ------------------------------------
  router.get(  '/cost-centers',         requirePermission('cost_center.read'),  query('finance.cost_center.list'));
  router.get(  '/cost-centers/:id',     requirePermission('cost_center.read'),  query('finance.cost_center.byId', (req) => ({ id: req.params.id })));
  router.post( '/cost-centers',         requirePermission('cost_center.write'), call('finance.cost_center.create'));
  router.put(  '/cost-centers/:id',     requirePermission('cost_center.write'), call('finance.cost_center.update',
    (req) => Object.assign({ id: req.params.id }, req.body || {})));
  router.post( '/cost-centers/:id/disable', requirePermission('cost_center.write'),
    call('finance.cost_center.disable', (req) => ({ id: req.params.id })));

  // ---- Revenue Posting Map (Phase 8 / C12) -----------------------------
  router.get(  '/revenue-map',          requirePermission('revenue_map.read'),  query('finance.revenue_map.list'));
  router.post( '/revenue-map',          requirePermission('revenue_map.write'), call('finance.revenue_map.upsert'));
  router.post( '/revenue-map/delete',   requirePermission('revenue_map.write'), call('finance.revenue_map.delete'));

  // ---- Ledger (Phase 8) ------------------------------------------------
  router.post( '/ledger/post',          requirePermission('ledger.write'),  call('finance.ledger.post'));
  router.post( '/ledger/validate',      requirePermission('ledger.read'),   call('finance.ledger.validate'));
  router.post( '/ledger/revert',        requirePermission('ledger.revert'), call('finance.ledger.revert'));
  router.get(  '/ledger/by-reference',  requirePermission('ledger.read'),   query('finance.ledger.by_reference'));

  // ---- Reports (Phase 8) -----------------------------------------------
  router.get(  '/reports/cost-center',  requirePermission('ledger.read'),   query('finance.cost_center.report'));
  router.get(  '/reports/revenue',      requirePermission('ledger.read'),   query('finance.revenue.summary'));

  return router;
}

module.exports = { build };
