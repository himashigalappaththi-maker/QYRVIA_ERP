'use strict';

/** Phase 23 R2 (Step 4) — shared error-envelope builder + ERROR_ENVELOPE flag. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Re-load the module with a chosen flag value (env reads ERROR_ENVELOPE at require time).
function loadFresh(mode) {
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/middleware/errorEnvelope')];
  if (mode === undefined) delete process.env.ERROR_ENVELOPE; else process.env.ERROR_ENVELOPE = mode;
  return require('../src/middleware/errorEnvelope');
}

test('buildError always returns { code, message }', () => {
  const { buildError } = loadFresh('string');
  assert.deepEqual(buildError('x_required', 'X is required'), { code: 'x_required', message: 'X is required' });
  assert.deepEqual(buildError('x_required'), { code: 'x_required', message: 'x_required' }); // message falls back to code
  assert.deepEqual(buildError(), { code: 'internal_error', message: 'internal_error' });     // empty falls back
});

test('errorField default (no flag) is legacy string', () => {
  const { errorField } = loadFresh(undefined);
  assert.equal(errorField('not_found'), 'not_found');
});

test('errorField legacy string mode emits the bare code (message ignored)', () => {
  const { errorField } = loadFresh('string');
  assert.equal(errorField('room_type_id_required'), 'room_type_id_required');
  assert.equal(errorField('room_type_id_required', 'room type id is required'), 'room_type_id_required');
});

test('errorField object mode emits { code, message }', () => {
  const { errorField } = loadFresh('object');
  assert.deepEqual(
    errorField('room_type_id_required', 'room type id is required'),
    { code: 'room_type_id_required', message: 'room type id is required' }
  );
  assert.deepEqual(errorField('not_found'), { code: 'not_found', message: 'not_found' });
});
