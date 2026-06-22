'use strict';

/**
 * pmsBridge - READ-ONLY access to PMS truth for building an inventory snapshot
 * that the (pure) QTCN engine consumes. It never writes to the PMS.
 *
 * The engine itself takes a plain snapshot object, so this bridge is the place
 * that touches the database (read-only) and produces that object. In tests the
 * snapshot is supplied directly and this bridge is exercised with fakes.
 */

function buildPmsBridge({ pmsRepo, availabilityService } = {}) {
  return {
    /**
     * Build a read-only inventory snapshot for a property/room-type/date.
     * `channelAvailability` (per-channel pms vs ota counts) is filled by the
     * channel sync layer in a later phase; here it defaults to empty so the
     * engine's mismatch risk is 0 unless provided.
     */
    async inventorySnapshot({ tenantId, propertyId, roomTypeId, date, channels } = {}) {
      let pmsCount = null;
      if (availabilityService && typeof availabilityService.countAvailable === 'function') {
        pmsCount = await availabilityService.countAvailable({ tenantId, propertyId, roomTypeId, date });
      } else if (pmsRepo && typeof pmsRepo.findRoomTypeById === 'function' && roomTypeId) {
        // Read-only existence check; real counting lands with the availability wiring.
        const rt = await pmsRepo.findRoomTypeById(tenantId, roomTypeId);
        pmsCount = rt ? null : 0;
      }
      return {
        propertyId: propertyId || null,
        roomTypeId: roomTypeId || null,
        date: date || null,
        pmsCount,
        availableChannels: Array.isArray(channels) ? channels.slice() : [],
        channelAvailability: {}
      };
    }
  };
}

module.exports = { buildPmsBridge };
