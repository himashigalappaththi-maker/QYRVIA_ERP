'use strict';

/** Airbnb OTA adapter (Phase 10.2). One OTA = one file. */
const { OTAAdapter } = require('../base/assertAdapter');

class AirbnbAdapter extends OTAAdapter {
  constructor() { super('airbnb', { commissionPct: 14 }); }
}

module.exports = { channel: 'airbnb', Adapter: AirbnbAdapter };
