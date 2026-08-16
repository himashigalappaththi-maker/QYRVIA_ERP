'use strict';

/**
 * Phase 68B (instruction 046) — static regression guard.
 *
 * Protects the Channel Manager / ARI live-DB regression set from
 * accidentally reintroducing destructive schema-reset setup against the
 * shared, already-provisioned qyrvia_test database. Instruction 044 found
 * that `phase66a_channel_queue_dedupe.db.test.js` called `H.freshSchema(pool)`
 * (`DROP SCHEMA IF EXISTS public CASCADE` + a full migration replay) in its
 * own `before()` hook — safe in isolation (every sibling DB test file
 * tolerates a schema reset), but destructive to any state a DIFFERENT,
 * concurrently-authored instruction/session has already proven live against
 * the SAME shared database (a freshly-applied migration, a freshly-installed
 * superuser bootstrap object) and a violation of this repository's standing
 * live-test safety boundary for this validation path.
 *
 * This is a PURE STATIC test — it reads each target file's SOURCE TEXT and
 * never opens a database connection, so it runs under the normal, fast
 * `npm run test:unit` suite (no TEST_DATABASE_URL required) and catches a
 * regression before anyone even reaches for `npm run test:db`.
 *
 * Comment-stripping order matters: full-line `//` comments are removed
 * FIRST, then `/* ... *\/` blocks — stripping line comments before block
 * comments means a stray `/*`-looking sequence inside an already-removed
 * `//` line can never be misread as the start of a real block comment (the
 * inverse order has bitten this exact class of guard test elsewhere in this
 * repository). This file's own explanatory prose ("no DROP SCHEMA", "no
 * migration run inside this file", etc., already present in every target
 * file) is exactly the kind of comment this stripping must neutralize —
 * the guard fails on CODE, never on documentation describing the absence of
 * the very thing being guarded against.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DB_DIR = path.join(__dirname, 'db');

// Every live-DB file in this Channel Manager / ARI validation path,
// per instruction 046 Section 8's explicit minimum coverage list.
const GUARDED_FILES = [
  'phase66a_b2nd_ari_outbox_worker.db.test.js',
  'phase66a_b2nb_ari_outbox.db.test.js',
  'phase66a_channel_queue_dedupe.db.test.js',
  'phase66a_channel_queue_resolver_claiming.db.test.js',
  'phase66a_channel_queue_retry_dead_letter.db.test.js',
  'phase66a_channel_worker_queue.db.test.js',
  'phase67a_rls_live.db.test.js',
  'phase68_ari_channel_delivery.db.test.js'
];

const FORBIDDEN = [
  { name: 'freshSchema(',  re: /freshSchema\s*\(/ },
  { name: 'DROP SCHEMA',   re: /\bDROP\s+SCHEMA\b/i },
  { name: 'DROP DATABASE', re: /\bDROP\s+DATABASE\b/i },
  { name: 'TRUNCATE',      re: /\bTRUNCATE\b/i }
];

/** Strip full-line `//` comments first, THEN `/* *\/` blocks — see header. */
function codeOnly(src) {
  const noLineComments = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  return noLineComments.replace(/\/\*[\s\S]*?\*\//g, '');
}

for (const filename of GUARDED_FILES) {
  test('GUARD: ' + filename + ' contains no destructive live-DB setup (freshSchema/DROP SCHEMA/DROP DATABASE/TRUNCATE)', () => {
    const fullPath = path.join(DB_DIR, filename);
    assert.ok(fs.existsSync(fullPath), 'guarded file must exist: ' + filename);
    const src = fs.readFileSync(fullPath, 'utf8');
    const code = codeOnly(src);

    for (const f of FORBIDDEN) {
      assert.ok(!f.re.test(code),
        filename + ' must not contain executable ' + f.name +
        ' — this validation path must never reset or destructively mutate the shared qyrvia_test database');
    }
  });
}

// A meta-check: the guard's own comment-stripping must not itself be fooled
// by the exact kind of prose these files already contain — proves this guard
// does not produce false positives from documentation.
test('GUARD self-check: explanatory prose mentioning the forbidden terms does not trip the guard', () => {
  // Mirrors this repository's actual comment style in the 8 guarded files
  // exactly: full-line `//` and block `/** ... */` — never an inline
  // trailing `//` comment sharing a line with real code, which this guard's
  // (deliberately conservative, same-convention-as-elsewhere) line-comment
  // stripper does not attempt to separate from preceding code on that line.
  const sample = [
    "'use strict';",
    '/**',
    ' * no CREATE ROLE, no DROP SCHEMA, no migration run inside this file;',
    ' * TRUNCATE and freshSchema( are both absent from this file.',
    ' */',
    '// not a DROP SCHEMA, not a TRUNCATE, not freshSchema( — just prose',
    'const x = 1;',
    'console.log(x);'
  ].join('\n');
  const code = codeOnly(sample);
  for (const f of FORBIDDEN) {
    assert.ok(!f.re.test(code), 'false positive on prose-only mention of: ' + f.name);
  }
});

test('GUARD self-check: an actual destructive call IS caught', () => {
  const sample = [
    "'use strict';",
    'async function bad(pool) {',
    '  await H.freshSchema(pool);',
    "  await pool.query('DROP TABLE foo');",
    '}'
  ].join('\n');
  const code = codeOnly(sample);
  assert.ok(FORBIDDEN[0].re.test(code), 'freshSchema( call must be detected');
});
