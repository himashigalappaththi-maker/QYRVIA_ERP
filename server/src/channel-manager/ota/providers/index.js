'use strict';

/** OTA transport provider registry (Phase 30.2). One provider per channel. */

const { bookingcom } = require('./bookingcom');
const { expedia } = require('./expedia');

const PROVIDERS = Object.freeze({ [bookingcom.channel]: bookingcom, [expedia.channel]: expedia });

function getProvider(channel) {
  const p = PROVIDERS[channel];
  if (!p) throw new Error('ota: no transport provider for channel ' + channel);
  return p;
}
function hasProvider(channel) { return !!PROVIDERS[channel]; }
function listProviders() { return Object.keys(PROVIDERS).sort(); }

module.exports = { getProvider, hasProvider, listProviders, PROVIDERS };
