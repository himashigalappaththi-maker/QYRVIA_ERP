'use strict';

/**
 * pricingEngine (Booking Engine v1) - deterministic, no external calls, no AI.
 * total = base_rate + taxes - discounts, where base_rate = ratePerNight * nights
 * and taxes = base_rate * taxRatePct%. Fully test-pinned (no drift).
 */

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function buildPricingEngine({ defaultTaxRatePct = 15 } = {}) {
  return {
    quote({ ratePerNight = 0, nights = 1, discounts = 0, currency = 'USD', taxRatePct } = {}) {
      const rate = Number(ratePerNight) || 0;
      const n = Math.max(1, Number(nights) || 1);
      const base_rate = round2(rate * n);
      const pct = taxRatePct != null ? Number(taxRatePct) : defaultTaxRatePct;
      const taxes = round2(base_rate * (pct / 100));
      const disc = round2(discounts);
      const total = round2(base_rate + taxes - disc);
      return { ok: total > 0, base_rate, taxes, discounts: disc, total, currency: currency || 'USD' };
    }
  };
}

module.exports = { buildPricingEngine };
