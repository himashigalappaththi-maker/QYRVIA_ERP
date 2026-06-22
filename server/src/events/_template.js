'use strict';

/**
 * Event factory call template. Domain events are constructed inline inside
 * command handlers - there is no per-event file. This template exists to
 * document the call shape.
 */

const { makeEvent } = require('../core/event');

// Inside a command handler:
//
//   const ev = makeEvent({
//     type:          'reservation.created',
//     aggregateType: 'reservation',
//     aggregateId:   newReservationId,
//     payload: {
//       guestId:  input.guestId,
//       roomId:   input.roomId,
//       checkIn:  input.checkIn,
//       checkOut: input.checkOut,
//       total:    computedTotal
//     },
//     ctx   // { tenantId, propertyId, requestId, actorId }
//   });
//
// then return { ok:true, result:..., events:[ev] } from the handler. The
// commandBus publishes the events through eventBus, which persists them to
// audit_events via the built-in subscriber.

module.exports = { makeEvent };
