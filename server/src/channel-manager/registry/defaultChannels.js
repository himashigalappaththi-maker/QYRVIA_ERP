'use strict';

/**
 * Phase 49 — canonical list of default supported channels.
 *
 * Rules:
 *   - channel_code matches adapter.channel (CHANNELS constant in types.js).
 *   - qtcn:true channels seed as enabled=true, status='live' (internal, no cert needed).
 *   - All others seed as enabled=false, status='not_configured'.
 *   - commissionPct is informational only; never auto-applied to invoices.
 *   - This list defines what appears in Channel Manager for every new property.
 *     Operators may add custom OTAs beyond these 8 via POST /api/channel/registry.
 */

const DEFAULT_CHANNELS = [
  { code: 'BOOKING_COM', name: 'Booking.com',     commissionPct: 15, internal: false },
  { code: 'AGODA',       name: 'Agoda',           commissionPct: 14, internal: false },
  { code: 'EXPEDIA',     name: 'Expedia',         commissionPct: 16, internal: false },
  { code: 'AIRBNB',      name: 'Airbnb',          commissionPct: 3,  internal: false },
  { code: 'MAKEMYTRIP',  name: 'MakeMyTrip',      commissionPct: 16, internal: false },
  { code: 'GOOGLE',      name: 'Google Hotel Ads',commissionPct: 0,  internal: false },
  { code: 'TRIPADVISOR', name: 'TripAdvisor',     commissionPct: 17, internal: false },
  { code: 'QTCN',        name: 'QYRVIA Connect',  commissionPct: 0,  internal: true  },
];

module.exports = { DEFAULT_CHANNELS };
