'use strict';

/**
 * Phase 54 D10 — Guest validation tests (Item 8).
 * Tests bookingValidator direct/OTA channel rules and field length/range caps.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { buildBookingValidator } = require('../src/booking-engine/bookingValidator');

// Shared helpers
const validator = buildBookingValidator({});

const AVAIL_OK   = { available: true, rooms: 5 };
const PRICING_OK = { ok: true, total: 230 };

function baseInput(over = {}) {
  return Object.assign({
    room_type_id: 'rt1',
    arrival:      '2026-08-01',
    departure:    '2026-08-03',
    adults:       2,
    channel:      'DIRECT',
    holder_guest_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  }, over);
}

// 1. Direct booking (no channel) with no holder_guest_id -> validation fails
test('validation: DIRECT booking without holder_guest_id fails with required_for_direct_booking', () => {
  const input = baseInput({ holder_guest_id: undefined });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'VALIDATION_FAILED');
  const hasGuestErr = result.detail.some(d => d && d.field === 'holder_guest_id' && d.reason === 'required_for_direct_booking');
  assert.ok(hasGuestErr, 'should surface required_for_direct_booking detail');
});

// 2. Direct booking with empty string holder_guest_id -> validation fails
test('validation: DIRECT booking with empty string holder_guest_id fails', () => {
  const input = baseInput({ holder_guest_id: '' });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, false);
  const hasGuestErr = result.detail.some(d => d && d.field === 'holder_guest_id');
  assert.ok(hasGuestErr, 'empty string holder_guest_id should fail');
});

// 3. Direct booking with whitespace-only holder_guest_id -> validation fails
test('validation: DIRECT booking with whitespace-only holder_guest_id fails', () => {
  const input = baseInput({ holder_guest_id: '   ' });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, false);
  const hasGuestErr = result.detail.some(d => d && d.field === 'holder_guest_id');
  assert.ok(hasGuestErr, 'whitespace holder_guest_id should fail');
});

// 4. Direct booking with valid UUID holder_guest_id -> validation passes
test('validation: DIRECT booking with valid holder_guest_id UUID passes', () => {
  const input = baseInput({ holder_guest_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, true);
});

// 5. OTA booking (BOOKING_COM) with no holder_guest_id -> validation passes
test('validation: OTA (BOOKING_COM) booking without holder_guest_id passes', () => {
  const input = baseInput({ channel: 'BOOKING_COM', holder_guest_id: undefined });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, true, 'OTA channel should not require holder_guest_id');
});

// 6. EXPEDIA channel with no holder_guest_id -> validation passes
test('validation: OTA (EXPEDIA) booking without holder_guest_id passes', () => {
  const input = baseInput({ channel: 'EXPEDIA', holder_guest_id: undefined });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, true, 'EXPEDIA channel should not require holder_guest_id');
});

// 7. WEB channel (case-insensitive) with no holder_guest_id -> validation fails
test('validation: WEB channel without holder_guest_id fails', () => {
  const input = baseInput({ channel: 'WEB', holder_guest_id: undefined });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, false);
  const hasGuestErr = result.detail.some(d => d && d.field === 'holder_guest_id');
  assert.ok(hasGuestErr, 'WEB channel should require holder_guest_id');
});

// 8. WEB channel lowercase -> also fails (case-insensitive check)
test('validation: web (lowercase) channel without holder_guest_id fails', () => {
  const input = baseInput({ channel: 'web', holder_guest_id: undefined });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, false);
  const hasGuestErr = result.detail.some(d => d && d.field === 'holder_guest_id');
  assert.ok(hasGuestErr, 'lowercase web channel should also fail holder_guest_id check');
});

// 9. guest_name over 200 chars -> validation fails with max_length_200
test('validation: guest_name over 200 chars fails with max_length_200', () => {
  const longName = 'A'.repeat(201);
  const input = baseInput({ guest_name: longName });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, false);
  const hasLenErr = result.detail.some(d => d && d.field === 'guest_name' && d.reason === 'max_length_200');
  assert.ok(hasLenErr, 'should surface max_length_200 for guest_name');
});

// 10. guest_name exactly 200 chars -> passes
test('validation: guest_name exactly 200 chars passes', () => {
  const input = baseInput({ guest_name: 'B'.repeat(200) });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, true);
});

// 11. notes over 2000 chars -> validation fails with max_length_2000
test('validation: notes over 2000 chars fails with max_length_2000', () => {
  const longNotes = 'N'.repeat(2001);
  const input = baseInput({ notes: longNotes });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, false);
  const hasLenErr = result.detail.some(d => d && d.field === 'notes' && d.reason === 'max_length_2000');
  assert.ok(hasLenErr, 'should surface max_length_2000 for notes');
});

// 12. notes exactly 2000 chars -> passes
test('validation: notes exactly 2000 chars passes', () => {
  const input = baseInput({ notes: 'X'.repeat(2000) });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, true);
});

// 13. adults: 51 -> validation fails with max_50
test('validation: adults: 51 fails with max_50', () => {
  const input = baseInput({ adults: 51 });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, false);
  const hasRangeErr = result.detail.some(d => d && d.field === 'adults' && d.reason === 'max_50');
  assert.ok(hasRangeErr, 'should surface max_50 for adults: 51');
});

// 14. adults: 50 -> passes (boundary)
test('validation: adults: 50 passes (boundary)', () => {
  const input = baseInput({ adults: 50 });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, true);
});

// 15. children: 51 -> validation fails with max_50
test('validation: children: 51 fails with max_50', () => {
  const input = baseInput({ children: 51 });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, false);
  const hasRangeErr = result.detail.some(d => d && d.field === 'children' && d.reason === 'max_50');
  assert.ok(hasRangeErr, 'should surface max_50 for children: 51');
});

// 16. Missing room_type_id -> fails with room_type_required
test('validation: missing room_type_id fails with room_type_required', () => {
  const input = baseInput({ room_type_id: undefined });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes('room_type_required'));
});

// 17. Invalid dates -> fails with invalid_dates
test('validation: arrival >= departure fails with invalid_dates', () => {
  const input = baseInput({ arrival: '2026-08-03', departure: '2026-08-01' });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes('invalid_dates'));
});

// 18. adults: 0 -> fails with adult_required
test('validation: adults: 0 fails with adult_required', () => {
  const input = baseInput({ adults: 0 });
  const result = validator.validate(input, { availability: AVAIL_OK, pricing: PRICING_OK });
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes('adult_required'));
});
