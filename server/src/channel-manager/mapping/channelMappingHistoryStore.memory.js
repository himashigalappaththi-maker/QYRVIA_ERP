'use strict';

/**
 * In-memory append-only mapping history store (Phase 24 B8-B2). One immutable
 * snapshot row per mapping change. Pure, deterministic (injectable clock).
 */

const clone = (o) => (o ? Object.assign({}, o) : null);
const matches = (it, filter) => !filter || Object.entries(filter).every(([k, v]) => it[k] === v);

function buildChannelMappingHistoryStoreMemory({ clock = () => Date.now() } = {}) {
  const rows = [];
  let seq = 0;

  function append(rec) {
    if (!rec || !rec.tenant_id || rec.mapping_version == null || !rec.change_type) return { accepted: false, reason: 'invalid' };
    const item = Object.assign({ id: 'mh_' + (++seq) }, rec, { changed_at: rec.changed_at != null ? rec.changed_at : clock() });
    rows.push(item);
    return { accepted: true, item: clone(item) };
  }
  function list(filter) { return rows.filter((r) => matches(r, filter)).map(clone); }
  function size() { return rows.length; }
  function clear() { rows.length = 0; seq = 0; }

  return { append, list, size, clear };
}

module.exports = { buildChannelMappingHistoryStoreMemory };
