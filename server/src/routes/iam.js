'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');

/**
 * /api/iam/* surface (Phase 21) - read-only IAM listings for the admin UI.
 * Reads only; user/role mutation stays with the existing auth.user.create command.
 */
function build({ queryBus }) {
  const router = express.Router();
  if (!queryBus) return router;

  function query(queryName, mapInput) {
    return async function (req, res, next) {
      try {
        const input = mapInput ? mapInput(req) : Object.assign({}, req.query);
        const outcome = await queryBus.execute(queryName, input, req.ctx);
        res.status(outcome.ok ? 200 : 400).json(Object.assign({ requestId: req.ctx.requestId }, outcome));
      } catch (err) { next(err); }
    };
  }

  router.get('/users', requirePermission('auth.user.create'), query('iam.users.list'));
  router.get('/roles', requirePermission('auth.user.create'), query('iam.roles.list'));

  return router;
}

module.exports = { build };
