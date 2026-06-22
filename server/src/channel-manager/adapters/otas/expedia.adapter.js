'use strict';

/** Expedia OTA adapter (Phase 10.2). One OTA = one file. */
const { OTAAdapter } = require('../base/assertAdapter');

class ExpediaAdapter extends OTAAdapter {
  constructor() { super('expedia', { commissionPct: 20 }); }
}

module.exports = { channel: 'expedia', Adapter: ExpediaAdapter };
