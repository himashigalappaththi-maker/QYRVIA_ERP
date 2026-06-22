'use strict';

/**
 * QTCN as a NORMAL OTA adapter (Phase 10.2).
 *
 * Deliberately identical in shape and behavior to every other adapter - it
 * extends the same base, exposes the same 5-method contract, flows through the
 * same registry/factory/sync path, and has NO privileged logic and NO bypass.
 * The only difference is data: it is zero-commission. It is "just another OTA
 * provider in the registry."
 */
const { OTAAdapter } = require('../base/assertAdapter');

class QytnAdapter extends OTAAdapter {
  constructor() { super('qytn', { commissionPct: 0 }); }
}

module.exports = { channel: 'qytn', Adapter: QytnAdapter };
