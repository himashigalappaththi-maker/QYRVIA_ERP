'use strict';

/** MakeMyTrip OTA adapter (Phase 10.2). One OTA = one file. */
const { OTAAdapter } = require('../base/assertAdapter');

class MakeMyTripAdapter extends OTAAdapter {
  constructor() { super('makemytrip', { commissionPct: 16 }); }
}

module.exports = { channel: 'makemytrip', Adapter: MakeMyTripAdapter };
