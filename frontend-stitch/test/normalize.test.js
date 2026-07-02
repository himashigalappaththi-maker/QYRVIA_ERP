import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrap, asArray, asObject } from '../src/utils/normalize.js';

test('unwrap handles { data } (pms/finance) and { result } (revenue/platform)', () => {
  assert.deepEqual(unwrap({ ok: true, data: [1, 2] }), [1, 2]);
  assert.deepEqual(unwrap({ ok: true, result: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrap([3, 4]), [3, 4]);
  assert.equal(unwrap(null), null);
  assert.deepEqual(unwrap({ a: 1 }), { a: 1 });   // bare payload
});

test('asArray coerces all envelope shapes to arrays', () => {
  assert.deepEqual(asArray({ data: [1] }), [1]);
  assert.deepEqual(asArray({ result: [2] }), [2]);
  assert.deepEqual(asArray([3]), [3]);
  assert.deepEqual(asArray({ result: { rows: [4] } }), [4]);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray({ result: { foo: 'bar' } }), []);
});

test('asObject returns objects, not arrays/null', () => {
  assert.deepEqual(asObject({ result: { a: 1 } }), { a: 1 });
  assert.deepEqual(asObject({ data: [1] }), {});
  assert.deepEqual(asObject(null), {});
});
