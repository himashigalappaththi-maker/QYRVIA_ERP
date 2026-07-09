'use strict';

/**
 * Phase 49 — canonical list of default supported channels.
 *
 * Rules:
 *   - channel_code matches adapter.channel (CHANNELS constant in types.js).
 *   - qyrvia_owned:true channels seed as enabled=true, status='live' (QYRVIA-owned platform, no external certification required).
 *   - All others seed as enabled=false, status='not_configured'.
 *   - commissionPct is informational only; never auto-applied to invoices.
 *   - This list defines what appears in Channel Manager for every new property.
 *     Operators may add custom OTAs beyond these 8 via POST /api/channel/registry.
 */

const DEFAULT_CHANNELS = [
  { code: 'BOOKING_COM', name: 'Booking.com',     commissionPct: 15, qyrvia_owned: false },
  { code: 'AGODA',       name: 'Agoda',           commissionPct: 14, qyrvia_owned: false },
  { code: 'EXPEDIA',     name: 'Expedia',         commissionPct: 16, qyrvia_owned: false },
  { code: 'AIRBNB',      name: 'Airbnb',          commissionPct: 3,  qyrvia_owned: false },
  { code: 'MAKEMYTRIP',  name: 'MakeMyTrip',      commissionPct: 16, qyrvia_owned: false },
  { code: 'GOOGLE',      name: 'Google Hotel Ads',commissionPct: 0,  qyrvia_owned: false },
  { code: 'TRIPADVISOR', name: 'TripAdvisor',     commissionPct: 17, qyrvia_owned: false },
  { code: 'QYRVIA_CONNECT', name: 'QYRVIA Connect', commissionPct: 0, qyrvia_owned: true },
];

module.exports = { DEFAULT_CHANNELS };
