// Pure front-office logic (no DOM, no network) - unit-tested in Node. Mirrors
// the backend reservation lifecycle (commands/pms): INQUIRY|OPTION -> CONFIRMED
// -> CHECKED_IN -> CHECKED_OUT, with CANCELLED / NO_SHOW branches. The UI uses
// these guards only to show/hide actions; the backend still authorizes every call.

export const STATUS = {
  INQUIRY: 'INQUIRY', OPTION: 'OPTION', CONFIRMED: 'CONFIRMED',
  CHECKED_IN: 'CHECKED_IN', CHECKED_OUT: 'CHECKED_OUT',
  CANCELLED: 'CANCELLED', NO_SHOW: 'NO_SHOW'
};

const s = (r) => String((r && r.status) || '').toUpperCase();

export function canConfirm(r) { return ['INQUIRY', 'OPTION'].includes(s(r)); }
export function canCancel(r) { return ['INQUIRY', 'OPTION', 'CONFIRMED'].includes(s(r)); }
export function canNoShow(r) { return s(r) === 'CONFIRMED'; }
export function canCheckIn(r) { return s(r) === 'CONFIRMED'; }
export function canCheckOut(r) { return s(r) === 'CHECKED_IN'; }

/** Today's arrivals: confirmed bookings whose arrival is on/just before `today`. */
export function deriveArrivals(rows, today) {
  return (rows || []).filter((r) => s(r) === 'CONFIRMED' && String(r.arrival_date).slice(0, 10) <= today);
}
/** Today's departures: in-house stays due to leave on/before `today`. */
export function deriveDepartures(rows, today) {
  return (rows || []).filter((r) => s(r) === 'CHECKED_IN' && String(r.departure_date).slice(0, 10) <= today);
}
/** In-house: currently checked-in stays. */
export function deriveInHouse(rows) {
  return (rows || []).filter((r) => s(r) === 'CHECKED_IN');
}

export function countByStatus(rows) {
  const out = {};
  for (const r of (rows || [])) { const k = s(r); out[k] = (out[k] || 0) + 1; }
  return out;
}

/**
 * Map a create-reservation form object to the backend payload, validating the
 * fields the backend requires (pms.reservation.create). Returns
 * { ok, payload } or { ok:false, error }.
 */
export function buildReservationPayload(form) {
  const f = form || {};
  const req = ['holder_guest_id', 'primary_adult_guest_id', 'room_type_id', 'arrival_date', 'departure_date'];
  for (const k of req) if (!f[k]) return { ok: false, error: 'Missing required field: ' + k };
  if (String(f.departure_date) <= String(f.arrival_date)) return { ok: false, error: 'Departure must be after arrival' };
  const adults = Number(f.adults || 1);
  const children = Number(f.children || 0);
  if (!(adults >= 1)) return { ok: false, error: 'At least 1 adult required' };
  if (children < 0) return { ok: false, error: 'Children cannot be negative' };
  const payload = {
    reservation_type: f.reservation_type || 'INDIVIDUAL',
    holder_guest_id: f.holder_guest_id,
    primary_adult_guest_id: f.primary_adult_guest_id,
    room_type_id: f.room_type_id,
    arrival_date: f.arrival_date,
    departure_date: f.departure_date,
    adults, children,
    rooms_count: Number(f.rooms_count || 1)
  };
  if (f.rate_plan_id) payload.rate_plan_id = f.rate_plan_id;
  if (f.child_policy_id) payload.child_policy_id = f.child_policy_id;
  if (f.notes) payload.notes = f.notes;
  return { ok: true, payload };
}
