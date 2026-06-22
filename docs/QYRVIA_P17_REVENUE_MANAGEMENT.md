# QYRVIA Phase 17 — Revenue Management Engine (Dynamic Pricing & Forecasting)

> Deterministic pricing intelligence on top of the validated PMS operational +
> financial core (Phases 11–16). Additive / self-contained; JS / CommonJS;
> consumes upstream systems via events/read-only APIs only. **No AI/LLMs. No
> schema changes. Fully deterministic. Multi-property isolated. Respects the
> Business Date (Phase 16).**

## Modules (`server/src/revenue/`)

```
repository/revenueRepo.memory.js  rate plans, demand window, history, locked rates, overrides
core/DemandEngine.js              demandScore + occupancy/velocity/cancellation indices
core/SeasonalityEngine.js         deterministic calendar multiplier (dow x month x holiday)
core/PricingRuleEngine.js         OCCUPANCY_THRESHOLD / LEAD_TIME / LENGTH_OF_STAY / EVENT / SEASONAL
core/RateOptimizationEngine.js    base x demand x seasonal x rules -> clamp -> smooth
core/ForecastEngine.js            occupancy / ADR / RevPAR / revenue projections
core/RevenueIndexEngine.js        ADR / RevPAR / occupancy% + trend
core/RatePlanEngine.js            base/min/max, rule sets, seasonal, events, blackout, stability knobs
core/RevenueEngine.js             facade (getRate / generateRateGrid / getForecast / getRevenueKPIs / dashboard)
services/revenueSubscriber.js     read-only event consumption + day rollover
api/revenue.controller.js + routes.js   HTTP surface (mounted at /api/revenue)
```

## Pricing formula (deterministic)

```
raw = baseRate x demandMultiplier x seasonalMultiplier x ruleMultiplier
    -> clamp [minRate, maxRate]
    -> smooth toward previousRate (smoothingFactor) + cap daily change (maxDailyChangePct)
    -> clamp again
```

- **demandMultiplier** (0.8–1.4) from `demandScore` (occupancy pressure, booking
  velocity, cancellation pressure).
- **seasonalMultiplier** = day-of-week × month × holiday (clamped 0.5–2.0).
- **ruleMultiplier** = product of matched pricing-rule factors.
- Smoothing + the per-day change cap guarantee **no oscillation / no sudden
  jumps** — verified by the rate-grid stability test.

## Outputs

- **DynamicRateSnapshot** (frozen/immutable): `computedRate`, `demandScore`,
  `seasonalMultiplier`, `ruleImpact[]`, `confidenceScore` (deterministic), plus
  floor/cap and flags (`locked` / `override` / `blackout`).
- **Forecast**: per-date predicted occupancy, ADR, RevPAR, revenue + totals.
- **KPIs**: ADR, RevPAR, occupancy %, trend.
- **Rate grid**: smoothed snapshots across a date range.

## Integrity rules (enforced)

- **Confirmed/locked reservations are never re-priced** — `getRate({ reservationId })`
  returns the locked rate regardless of current demand.
- **No retroactive billing changes** — revenue is read-only; it writes only its
  own pricing records.
- **Manual overrides are audited** (user id + timestamp) and take precedence.
- **Multi-property isolation** — every method is `propertyId`-scoped.

## Event subscriptions (read-only)

`reservation.created` / `reservation.cancelled` → demand; `stay.started` /
`reservation.checked_in` → check-in; `stay.ended` / `reservation.completed` →
check-out; `invoice.finalized` → revenue; `dayend.completed` → roll the demand
window into history (respecting the Phase 16 business date). The engine never
mutates upstream systems.

## API (mounted at `/api/revenue`, RBAC via reserved `revenue.*` perms)

`GET /rate`, `GET /rate-grid`, `GET /forecast`, `GET /kpis`, `GET /dashboard`,
`POST /rate-plan`, `POST /override`.

## Tests (`test/revenue.test.js`) — all green

Seasonality accuracy · rule enforcement · clamp + smoothing (no jump) · snapshot
immutability · demand→price monotonicity · **rate-grid stability (≤20%/day)** ·
**locked-reservation protection** · audited override · **forecast determinism** ·
event-driven demand updates · multi-property isolation.

## Success criteria — met

Prices adjust dynamically with demand; revenue is forecast per property/date
range; pricing is stable + auditable; existing confirmed bookings are never
altered; everything is deterministic (no AI); it integrates with Night Audit
business dates; multi-property isolation holds. No regression; full suite green.
