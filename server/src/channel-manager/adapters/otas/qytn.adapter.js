'use strict';

/**
 * QTCN as a NORMAL OTA adapter (Phase 10.2 / Phase 10 standardization).
 *
 * Deliberately identical in shape and behavior to every other adapter - it
 * extends the same base, exposes the same 5-method contract, flows through the
 * same registry/factory/sync path, and has NO privileged logic, NO bypass, and
 * NO routing/scoring/decision-making. It is "just another OTA provider in the
 * registry." Its only distinguishing attribute is its commercial model:
 * commission = 15% (revenue = bookings + ads + commission tracking).
 */
const { OTAAdapter } = require('../base/assertAdapter');

class QytnAdapter extends OTAAdapter {
  constructor() { super('qytn', { commissionPct: 15 }); }
}

module.exports = { channel: 'qytn', Adapter: QytnAdapter };
