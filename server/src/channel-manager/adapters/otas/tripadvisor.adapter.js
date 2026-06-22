'use strict';

/** TripAdvisor OTA adapter (Phase 10.2). One OTA = one file. */
const { OTAAdapter } = require('../base/assertAdapter');

class TripAdvisorAdapter extends OTAAdapter {
  constructor() { super('tripadvisor', { commissionPct: 17 }); }
}

module.exports = { channel: 'tripadvisor', Adapter: TripAdvisorAdapter };
