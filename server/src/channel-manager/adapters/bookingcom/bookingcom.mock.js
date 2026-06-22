'use strict';

/**
 * Mock Booking.com inbound payloads (raw vendor shape, pre-canonical).
 * Stands in for the real reservations API until the live adapter ships.
 */

const MOCK_BOOKINGS = [
  { id: 'BC-123', guestName: 'Mock Guest', source: 'booking.com', status: 'CONFIRMED',
    checkin: '2026-07-01', checkout: '2026-07-03', amount: 240.00, currency: 'USD',
    roomType: 'STD' },
  { id: 'BC-124', guestName: 'Jane Traveller', source: 'booking.com', status: 'CONFIRMED',
    checkin: '2026-07-05', checkout: '2026-07-06', amount: 110.00, currency: 'USD',
    roomType: 'DLX' }
];

module.exports = { MOCK_BOOKINGS };
