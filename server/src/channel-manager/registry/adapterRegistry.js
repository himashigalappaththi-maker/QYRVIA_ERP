'use strict';

/**
 * adapterRegistry - the single source of truth for which OTAs exist.
 *
 * Adapters are discovered from the filesystem (`adapters/otas/*.adapter.js`),
 * so **adding an OTA is literally dropping one new file** - no registry edit,
 * no core change, no sync-engine change. Nothing in the system hardcodes an OTA
 * name; callers ask the registry.
 */

const fs = require('fs');
const factory = require('./adapterFactory');
const { assertAdapter } = require('../adapters/base/assertAdapter');

/** All adapter names available on disk (filename stems). */
function discover() {
  return fs.readdirSync(factory.OTAS_DIR)
    .filter((f) => f.endsWith('.adapter.js'))
    .map((f) => f.replace(/\.adapter\.js$/, ''));
}

function list() { return discover().sort(); }

function has(name) { return discover().includes(name); }

function get(name) {
  if (!has(name)) throw new Error('unknown_ota: ' + name);
  return factory.create(name);
}

function all() { return list().map(get); }

/** Validate every discovered adapter against the contract. */
function validateAll() {
  return list().map((name) => Object.assign({ name }, assertAdapter(get(name))));
}

module.exports = { discover, list, has, get, all, validateAll };
