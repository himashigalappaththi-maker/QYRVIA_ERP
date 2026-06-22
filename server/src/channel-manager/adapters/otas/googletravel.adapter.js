'use strict';

/** Google Travel OTA adapter (Phase 10.2). One OTA = one file. */
const { OTAAdapter } = require('../base/assertAdapter');

class GoogleTravelAdapter extends OTAAdapter {
  constructor() { super('googletravel', { commissionPct: 12 }); }
}

module.exports = { channel: 'googletravel', Adapter: GoogleTravelAdapter };
