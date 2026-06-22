'use strict';

/** Phase 10.0 - channel events persist through the shared eventBus and are
 *  replayable: booking state is a deterministic, idempotent fold of the log. */

// Env sentinels before requiring app modules (eventBus/core -> logger -> env).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const eventBus = require('../src/core/eventBus');
const { ChannelManagerCore } = require('../src/channel-manager/core/ChannelManagerCore');
const { BookingComAdapter } = require('../src/channel-manager/adapters/bookingcom/BookingComAdapter');
const { CHANNELS } = require('../src/channel-manager/core/canonical/types');

function freshBus() {
  eventBus.reset();
  const db = { auditRows: [], async insertAuditEvent(ev) { this.auditRows.push(ev); } };
  eventBus.init({ db });
  return db;
}

const CTX = { tenantId: 't-1', propertyId: 'p-1', requestId: 'rq-1', actorId: null, actorName: 'CMTest' };

test('channel events are persisted (audit-safe) and replayable into state', async () => {
  const db = freshBus();
  const core = new ChannelManagerCore();
  core.registerAdapter(new BookingComAdapter());

  await core.syncBookings(CHANNELS.BOOKING_COM, CTX);     // creates BC-123, BC-124 (CONFIRMED)
  await core.cancelBooking(CHANNELS.BOOKING_COM, 'BC-124', CTX);

  const events = db.auditRows.filter((e) => String(e.event_type).startsWith('channel.'));
  assert.ok(events.some((e) => e.event_type === 'channel.booking_created'));
  assert.ok(events.some((e) => e.event_type === 'channel.booking_cancelled'));

  // Replay the persisted log into booking state.
  const reducer = core.bookings.reducer;
  const state = events.reduce(reducer, { bookings: {} });
  assert.equal(state.bookings['BC-123'].status, 'CONFIRMED');
  assert.equal(state.bookings['BC-124'].status, 'CANCELLED');

  // Idempotent replay: folding the log twice yields identical state.
  const twice = events.concat(events).reduce(reducer, { bookings: {} });
  assert.deepEqual(twice, state);
});

test('re-sync of the same bookings is deduped (idempotent ingest)', async () => {
  freshBus();
  const core = new ChannelManagerCore();
  core.registerAdapter(new BookingComAdapter());
  const first = await core.syncBookings(CHANNELS.BOOKING_COM, CTX);
  const second = await core.syncBookings(CHANNELS.BOOKING_COM, CTX);
  assert.equal(first.created, 2);
  assert.equal(second.created, 0);
  assert.equal(second.deduped, 2);
});
