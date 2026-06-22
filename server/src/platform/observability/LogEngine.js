'use strict';

/**
 * LogEngine (Phase 18) - structured logs with a bounded in-memory buffer and an
 * optional sink (e.g. pino). Each entry carries eventType, module, propertyId,
 * userId, correlationId, timestamp.
 */

const LEVELS = ['debug', 'info', 'warn', 'error'];

function buildLogEngine({ clock, sink, max = 5000 } = {}) {
  const now = clock || (() => Date.now());
  const buffer = [];

  function record(level, fields = {}) {
    const entry = Object.assign({ level, timestamp: new Date(now()).toISOString() }, fields);
    buffer.push(entry);
    if (buffer.length > max) buffer.shift();
    if (sink && typeof sink[level] === 'function') { try { sink[level](entry); } catch (_) { /* ignore */ } }
    return entry;
  }

  const api = { query(filter = {}) {
    return buffer.filter((e) =>
      (!filter.level || e.level === filter.level)
      && (!filter.module || e.module === filter.module)
      && (!filter.propertyId || e.propertyId === filter.propertyId)
      && (!filter.correlationId || e.correlationId === filter.correlationId));
  }, _buffer: buffer };
  for (const lvl of LEVELS) api[lvl] = (fields) => record(lvl, fields);
  return api;
}

module.exports = { buildLogEngine, LEVELS };
