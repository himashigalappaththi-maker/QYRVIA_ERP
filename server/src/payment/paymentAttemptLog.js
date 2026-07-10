'use strict';
const { randomUUID } = require('crypto');

function buildPaymentAttemptLogMemory() {
  const _log = [];

  function insert(entry) {
    const row = Object.assign({ id: randomUUID(), created_at: new Date().toISOString() }, entry);
    _log.push(row);
    return row;
  }

  function listByReservation(reservationId) {
    return _log.filter(r => r.reservation_id === reservationId);
  }

  return { insert, listByReservation };
}

module.exports = { buildPaymentAttemptLogMemory };
