'use strict';

/** OTA transport provider registry. One provider per channel. */

const { bookingcom }   = require('./bookingcom');
const { expedia }      = require('./expedia');
const { agoda }        = require('./agoda');
const { airbnb }       = require('./airbnb');
const { makemytrip }   = require('./makemytrip');
const { google }       = require('./google');
const { tripadvisor }  = require('./tripadvisor');

const PROVIDERS = Object.freeze({
  [bookingcom.channel]:  bookingcom,
  [expedia.channel]:     expedia,
  [agoda.channel]:       agoda,
  [airbnb.channel]:      airbnb,
  [makemytrip.channel]:  makemytrip,
  [google.channel]:      google,
  [tripadvisor.channel]: tripadvisor,
});

function getProvider(channel) {
  const p = PROVIDERS[channel];
  if (!p) throw new Error('ota: no transport provider for channel ' + channel);
  return p;
}
function hasProvider(channel) { return !!PROVIDERS[channel]; }
function listProviders() { return Object.keys(PROVIDERS).sort(); }

module.exports = { getProvider, hasProvider, listProviders, PROVIDERS };
