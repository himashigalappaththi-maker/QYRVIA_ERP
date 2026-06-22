'use strict';

/**
 * channelManagerBridge - the ONLY seam between QTCN and the Channel Manager.
 *
 * QTCN never imports or mutates Channel Manager internals; it talks through
 * this bridge. The bridge is read-only for the data QTCN needs to build a
 * snapshot, plus a pure `plan()` that maps a QTCN decision onto a Channel
 * Manager target. Actual fulfillment (the side-effecting push) is deliberately
 * left to a later phase / the caller - keeping the QTCN layer free of I/O.
 */

// QTCN routing keys -> Channel Manager CHANNELS enum. Channels QTCN may route to
// that do not yet have a CM adapter map to null (adding one = a single new
// adapter file in the Channel Manager; nothing here needs to change first).
const CM_CHANNEL_BY_ROUTE_KEY = Object.freeze({
  QTCN: 'QTCN',
  'booking.com': 'BOOKING_COM',
  agoda: 'AGODA',
  expedia: 'EXPEDIA',
  airbnb: 'AIRBNB',
  makemytrip: null,
  'google.travel': null,
  tripadvisor: null
});

function buildChannelManagerBridge({ channelManager } = {}) {
  if (!channelManager) throw new Error('channelManagerBridge: channelManager required');

  return {
    /** READ-ONLY: channels the CM can currently execute against (enum keys). */
    availableChannels() {
      return channelManager.listChannels();
    },

    /** READ-ONLY: CM status snapshot. */
    status() {
      return channelManager.status();
    },

    /**
     * Pure mapping of a QTCN decision onto a fulfillment plan. No side effects.
     *   { route, target, cmChannel, executable }
     * `executable` is false when QTCN chose an OTA that has no CM adapter yet.
     */
    plan(decision) {
      const cmChannel = CM_CHANNEL_BY_ROUTE_KEY[decision.selectedChannel] || null;
      const registered = cmChannel ? channelManager.listChannels().includes(cmChannel) : false;
      return {
        route: decision.route,
        target: decision.selectedChannel,
        cmChannel,
        executable: !!registered
      };
    }
  };
}

module.exports = { buildChannelManagerBridge, CM_CHANNEL_BY_ROUTE_KEY };
