'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { buildDedupKey } = require('../src/channel-manager/ota/dedupKey');

const ascii = (n) => 'x'.repeat(n);
const emoji = (n) => '🎉'.repeat(n); // 4 UTF-8 bytes each

// ── External event ID ────────────────────────────────────────────────────────

test('same external ID gives same key', () => {
  assert.equal(
    buildDedupKey({ externalEventId: 'evt-abc-123' }),
    buildDedupKey({ externalEventId: 'evt-abc-123' })
  );
});

test('externalEventId returned as-is (no sha prefix) when within limit', () => {
  assert.equal(buildDedupKey({ externalEventId: 'evt-abc-123' }), 'evt-abc-123');
});

test('surrounding whitespace on externalEventId is normalized', () => {
  assert.equal(buildDedupKey({ externalEventId: '  evt-abc  ' }), 'evt-abc');
});

test('empty-string externalEventId falls through to payload', () => {
  const k = buildDedupKey({ externalEventId: '', payload: { room: 'DLX' } });
  assert.ok(k.startsWith('sha256:'));
});

test('whitespace-only externalEventId falls through to payload', () => {
  const k = buildDedupKey({ externalEventId: '   ', payload: { room: 'DLX' } });
  assert.ok(k.startsWith('sha256:'));
});

test('null externalEventId falls through to payload', () => {
  const k = buildDedupKey({ externalEventId: null, payload: { room: 'DLX' } });
  assert.ok(k.startsWith('sha256:'));
});

test('ID at exactly 512 UTF-8 bytes (ASCII) returned as-is', () => {
  const id = ascii(512);
  assert.equal(Buffer.byteLength(id, 'utf8'), 512);
  assert.equal(buildDedupKey({ externalEventId: id }), id);
});

test('ID over 512 UTF-8 bytes (ASCII) is sha256-hashed', () => {
  const k = buildDedupKey({ externalEventId: ascii(513) });
  assert.ok(k.startsWith('sha256:'));
  assert.equal(k.length, 71); // 'sha256:' (7) + 64 hex chars
});

test('ID at exactly 512 UTF-8 bytes (multibyte chars) returned as-is', () => {
  const id = emoji(128); // 4 bytes × 128 = 512 bytes
  assert.equal(Buffer.byteLength(id, 'utf8'), 512);
  assert.equal(buildDedupKey({ externalEventId: id }), id);
});

test('ID over 512 UTF-8 bytes (multibyte chars) is hashed based on byte length', () => {
  const id = emoji(129); // 4 bytes × 129 = 516 bytes
  assert.ok(Buffer.byteLength(id, 'utf8') > 512);
  const k = buildDedupKey({ externalEventId: id });
  assert.ok(k.startsWith('sha256:'));
});

test('oversized external ID path never exposes original value in key', () => {
  const id = 'SECRET-' + ascii(510);
  const k = buildDedupKey({ externalEventId: id });
  assert.ok(!k.includes('SECRET-'));
  assert.ok(k.startsWith('sha256:'));
});

test('returned key never exceeds 512 UTF-8 bytes', () => {
  const k = buildDedupKey({ externalEventId: ascii(600) });
  assert.ok(Buffer.byteLength(k, 'utf8') <= 512);
});

// ── Payload: key sorting and stability ───────────────────────────────────────

test('reordered object keys give the same hash', () => {
  assert.equal(
    buildDedupKey({ payload: { b: 2, a: 1 } }),
    buildDedupKey({ payload: { a: 1, b: 2 } })
  );
});

test('array order changes the hash', () => {
  assert.notEqual(
    buildDedupKey({ payload: { items: [1, 2, 3] } }),
    buildDedupKey({ payload: { items: [3, 2, 1] } })
  );
});

test('original payload object is not mutated', () => {
  const payload = { b: 2, a: 1, timestamp: 'volatile' };
  const before = JSON.stringify(payload);
  buildDedupKey({ payload });
  assert.equal(JSON.stringify(payload), before);
});

// ── Volatile / sensitive field exclusion ─────────────────────────────────────

test('volatile field timestamp does not change the hash', () => {
  assert.equal(
    buildDedupKey({ payload: { room: 'DLX', timestamp: '2024-01-01T00:00:00Z' } }),
    buildDedupKey({ payload: { room: 'DLX', timestamp: '2024-06-15T12:30:00Z' } })
  );
});

test('volatile field received_at does not change the hash', () => {
  assert.equal(
    buildDedupKey({ payload: { room: 'DLX', received_at: '2024-01-01' } }),
    buildDedupKey({ payload: { room: 'DLX', received_at: '2024-12-31' } })
  );
});

test('all sensitive and volatile fields are excluded', () => {
  const base = { booking_id: 'B1' };
  const withAll = {
    booking_id: 'B1',
    pan: '4111111111111111', password: 'secret', card_number: '4111',
    authorization: 'Bearer tok', access_token: 'tok123',
    security_code: '123', cvc: '321', cvv: '000',
    signature: 'sig', trace_id: 'tr-1', request_id: 'rq-1',
    received_at: 'now', timestamp: '2024'
  };
  assert.equal(buildDedupKey({ payload: base }), buildDedupKey({ payload: withAll }));
});

test('volatile key exclusion is case-insensitive', () => {
  assert.equal(
    buildDedupKey({ payload: { room: 'DLX', TIMESTAMP: '2024' } }),
    buildDedupKey({ payload: { room: 'DLX' } })
  );
});

test('nested volatile keys are excluded', () => {
  assert.equal(
    buildDedupKey({ payload: { booking: { id: 'B1', timestamp: 'x' } } }),
    buildDedupKey({ payload: { booking: { id: 'B1', timestamp: 'y' } } })
  );
});

test('business field change does change the hash', () => {
  assert.notEqual(
    buildDedupKey({ payload: { room_type: 'DLX', nights: 2 } }),
    buildDedupKey({ payload: { room_type: 'STD', nights: 2 } })
  );
});

// ── Error cases ───────────────────────────────────────────────────────────────

test('missing both ID and payload throws OTA_DEDUP_KEY_REQUIRED', () => {
  assert.throws(() => buildDedupKey({}), (e) => e.code === 'OTA_DEDUP_KEY_REQUIRED');
});

test('no arguments throws OTA_DEDUP_KEY_REQUIRED', () => {
  assert.throws(() => buildDedupKey(), (e) => e.code === 'OTA_DEDUP_KEY_REQUIRED');
});

test('empty object payload throws OTA_DEDUP_KEY_REQUIRED', () => {
  assert.throws(() => buildDedupKey({ payload: {} }), (e) => e.code === 'OTA_DEDUP_KEY_REQUIRED');
});

test('empty array payload throws OTA_DEDUP_KEY_REQUIRED', () => {
  assert.throws(() => buildDedupKey({ payload: [] }), (e) => e.code === 'OTA_DEDUP_KEY_REQUIRED');
});

test('null payload throws OTA_DEDUP_KEY_REQUIRED', () => {
  assert.throws(() => buildDedupKey({ payload: null }), (e) => e.code === 'OTA_DEDUP_KEY_REQUIRED');
});

test('payload with only volatile keys throws OTA_DEDUP_KEY_REQUIRED', () => {
  assert.throws(
    () => buildDedupKey({ payload: { timestamp: 'x', signature: 'y', cvv: '0' } }),
    (e) => e.code === 'OTA_DEDUP_KEY_REQUIRED'
  );
});

test('NaN as top-level payload throws OTA_DEDUP_KEY_REQUIRED', () => {
  assert.throws(() => buildDedupKey({ payload: NaN }), (e) => e.code === 'OTA_DEDUP_KEY_REQUIRED');
});

test('Infinity as top-level payload throws OTA_DEDUP_KEY_REQUIRED', () => {
  assert.throws(() => buildDedupKey({ payload: Infinity }), (e) => e.code === 'OTA_DEDUP_KEY_REQUIRED');
});

// ── Circular reference ────────────────────────────────────────────────────────

test('circular reference in object throws OTA_DEDUP_KEY_REQUIRED', () => {
  const obj = { a: 1 };
  obj.self = obj;
  assert.throws(() => buildDedupKey({ payload: obj }), (e) => e.code === 'OTA_DEDUP_KEY_REQUIRED');
});

test('circular reference in array throws OTA_DEDUP_KEY_REQUIRED', () => {
  const arr = [1, 2];
  arr.push(arr);
  assert.throws(() => buildDedupKey({ payload: { items: arr } }), (e) => e.code === 'OTA_DEDUP_KEY_REQUIRED');
});

test('circular reference error message does not contain payload content', () => {
  const obj = { secret_field: 'do-not-log' };
  obj.self = obj;
  try {
    buildDedupKey({ payload: obj });
    assert.fail('expected throw');
  } catch (e) {
    assert.equal(e.code, 'OTA_DEDUP_KEY_REQUIRED');
    assert.ok(!e.message.includes('do-not-log'));
    assert.ok(!e.message.includes('secret_field'));
  }
});

test('shared (non-circular) object references do not throw', () => {
  const shared = { val: 42 };
  const k = buildDedupKey({ payload: { x: shared, y: shared } });
  assert.ok(k.startsWith('sha256:'));
});

// ── Non-plain value types ─────────────────────────────────────────────────────

test('Date objects are handled deterministically', () => {
  const d1 = new Date('2024-06-15T12:00:00.000Z');
  const d2 = new Date('2024-06-15T12:00:00.000Z');
  assert.equal(
    buildDedupKey({ payload: { dt: d1 } }),
    buildDedupKey({ payload: { dt: d2 } })
  );
});

test('different Date values give different hashes', () => {
  assert.notEqual(
    buildDedupKey({ payload: { dt: new Date('2024-01-01') } }),
    buildDedupKey({ payload: { dt: new Date('2024-06-15') } })
  );
});

test('Buffer objects are handled deterministically', () => {
  assert.equal(
    buildDedupKey({ payload: { data: Buffer.from('hello') } }),
    buildDedupKey({ payload: { data: Buffer.from('hello') } })
  );
});

test('different Buffer content gives different hashes', () => {
  assert.notEqual(
    buildDedupKey({ payload: { data: Buffer.from('hello') } }),
    buildDedupKey({ payload: { data: Buffer.from('world') } })
  );
});

test('BigInt values are handled deterministically', () => {
  assert.equal(
    buildDedupKey({ payload: { amount: BigInt(12345) } }),
    buildDedupKey({ payload: { amount: BigInt(12345) } })
  );
});

test('different BigInt values give different hashes', () => {
  assert.notEqual(
    buildDedupKey({ payload: { amount: BigInt(100) } }),
    buildDedupKey({ payload: { amount: BigInt(200) } })
  );
});

test('undefined object field is treated as absent', () => {
  assert.equal(
    buildDedupKey({ payload: { a: 1, b: undefined } }),
    buildDedupKey({ payload: { a: 1 } })
  );
});

test('NaN as object field is treated as null (deterministic)', () => {
  assert.equal(
    buildDedupKey({ payload: { room: 'DLX', score: NaN } }),
    buildDedupKey({ payload: { room: 'DLX', score: null } })
  );
});

test('Infinity as object field is treated as null (deterministic)', () => {
  assert.equal(
    buildDedupKey({ payload: { room: 'DLX', rate: Infinity } }),
    buildDedupKey({ payload: { room: 'DLX', rate: null } })
  );
});
