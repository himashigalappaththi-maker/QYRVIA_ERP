'use strict';

/** Agoda OTA adapter (Phase 10.2). One OTA = one file. */
const { OTAAdapter } = require('../base/assertAdapter');

class AgodaAdapter extends OTAAdapter {
  constructor() { super('agoda', { commissionPct: 18 }); }
}

module.exports = { channel: 'agoda', Adapter: AgodaAdapter };
