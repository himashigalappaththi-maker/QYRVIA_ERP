'use strict';

const crypto = require('crypto');

const HEADER  = 'x-request-id';
const ID_RE   = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Assigns an `X-Request-Id` to every request. If the client supplied one
 * that looks safe, reuse it - otherwise generate a fresh UUID. Echo the
 * value back in the response header for client correlation.
 */
function requestId(req, res, next) {
  const incoming = req.get(HEADER);
  const id = (incoming && ID_RE.test(incoming)) ? incoming : crypto.randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

module.exports = requestId;
