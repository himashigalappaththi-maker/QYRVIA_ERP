'use strict';

/**
 * @deprecated Phase 24 B8-A: part of the SUPERSEDED filesystem-discovery adapter
 * framework. Use `adapters/framework/*` instead. Retained for backward
 * compatibility (ota_scale.test.js) until a later removal step.
 *
 * adapterFactory - instantiates OTA adapters dynamically with lazy loading.
 *
 * An adapter is loaded only when first requested (lazy `require`), then cached.
 * Every instance is validated against the 5-method contract before being
 * handed out, so a malformed adapter fails loudly at load time rather than
 * mid-sync.
 */

const path = require('path');
const { assertAdapter } = require('../adapters/base/assertAdapter');

const OTAS_DIR = path.join(__dirname, '..', 'adapters', 'otas');
const _cache = new Map();

function adapterFile(name) { return name + '.adapter.js'; }

function create(name) {
  if (_cache.has(name)) return _cache.get(name);

  let mod;
  try {
    mod = require(path.join(OTAS_DIR, adapterFile(name)));
  } catch (e) {
    throw new Error('unknown_ota_adapter: ' + name);
  }
  const Adapter = mod && mod.Adapter;
  if (typeof Adapter !== 'function') {
    throw new Error('adapter ' + name + ' does not export { Adapter }');
  }
  const instance = new Adapter();
  const check = assertAdapter(instance);
  if (!check.ok) {
    throw new Error('adapter ' + name + ' non-compliant: missing=' + check.missing.join(',') +
      ' notAsync=' + check.notAsync.join(','));
  }
  _cache.set(name, instance);
  return instance;
}

function clearCache() { _cache.clear(); }

module.exports = { create, clearCache, OTAS_DIR, adapterFile };
