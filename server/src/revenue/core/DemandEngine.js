'use strict';

/**
 * DemandEngine - aggregates real operational signals (fed by the read-only
 * event subscriber) into deterministic demand indices.
 *
 *   demandScore (0-100), occupancyPressureIndex, bookingVelocityIndex,
 *   cancellationPressureIndex, and the derived demandMultiplier (0.8 .. 1.4).
 */

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function buildDemandEngine({ repo } = {}) {
  if (!repo) throw new Error('DemandEngine: repo required');
  const requireProperty = (ctx) => { if (!ctx || !ctx.propertyId) throw new Error('property_required'); return ctx.propertyId; };

  return {
    async reservationCreated(ctx) { return repo.bumpDemand(requireProperty(ctx), 'reservationsCreated'); },
    async reservationCancelled(ctx) { return repo.bumpDemand(requireProperty(ctx), 'reservationsCancelled'); },
    async checkIn(ctx) { return repo.bumpDemand(requireProperty(ctx), 'checkIns'); },
    async checkOut(ctx) { return repo.bumpDemand(requireProperty(ctx), 'checkOuts'); },
    async recordRevenue(ctx, { amount = 0, rooms = 1 } = {}) {
      const propertyId = requireProperty(ctx);
      await repo.bumpDemand(propertyId, 'roomRevenue', Number(amount) || 0);
      return repo.bumpDemand(propertyId, 'roomsSold', Number(rooms) || 0);
    },
    async setCapacity(ctx, capacity) { return repo.setCapacity(requireProperty(ctx), capacity); },

    async compute(ctx) {
      const d = await repo.getDemand(requireProperty(ctx));
      const cap = Math.max(1, Number(d.capacity) || 0);
      const occupied = Math.max(0, d.checkIns - d.checkOuts);
      const occupancyPressureIndex = round2(clamp(occupied / cap, 0, 1));
      const bookingVelocityIndex = round2(clamp(d.reservationsCreated / cap, 0, 1));
      const cancellationPressureIndex = round2(clamp(d.reservationsCancelled / Math.max(1, d.reservationsCreated), 0, 1));
      const demandScore = clamp(Math.round(15 + 50 * occupancyPressureIndex + 35 * bookingVelocityIndex - 25 * cancellationPressureIndex), 0, 100);
      const demandMultiplier = round2(0.8 + (demandScore / 100) * 0.6);
      return { demandScore, occupancyPressureIndex, bookingVelocityIndex, cancellationPressureIndex, demandMultiplier };
    }
  };
}

module.exports = { buildDemandEngine };
