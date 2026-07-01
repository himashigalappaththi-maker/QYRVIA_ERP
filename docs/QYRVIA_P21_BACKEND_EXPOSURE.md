# QYRVIA Phase 21 — Backend Exposure Gap Closure

**Scope:** backend only. No frontend changes, no RBAC logic changes, no schema
changes. All additions follow the existing command/query-bus + route structure and
middleware (`requirePermission`, `req.ctx`). Every read returns `{ ok, data }` and
every write returns `{ ok, result }` — directly compatible with the frontend's
`unwrap()` / `asArray()` / `asObject()` helpers.

**Tests:** `server` unit suite **455 passing** (incl. 9 new Phase-21 tests in
`test/pms_phase21_exposure.test.js`).

## Path note
The prompt used unprefixed paths (`/reservations`, `/folios`, `/users`…). To follow
existing structure, endpoints are mounted under their domain routers:
`/api/pms/*`, `/api/finance/*`, `/api/iam/*`.

---

## Newly implemented endpoints

### Reservations (write)
| Method | Path | Command | Permission |
|---|---|---|---|
| PUT | `/api/pms/reservations/:id` | `pms.reservation.update` | `pms.reservation.write` |
| POST | `/api/pms/reservations/:id/room-move` | `pms.reservation.room_move` | `pms.reservation.write` |
| POST | `/api/pms/reservations/:id/check-in` | `pms.reservation.checkin` (alias) | `pms.reservation.write` |
| POST | `/api/pms/reservations/:id/check-out` | `pms.reservation.checkout` (alias) | `pms.reservation.write` |
| POST | `/api/pms/reservations/:id/force-checkout` | `pms.reservation.checkout` (mode=FORCE, force_close) | `pms.reservation.write` |
| POST | `/api/pms/reservations/:id/early-checkout` | `pms.reservation.checkout` (mode=EARLY) | `pms.reservation.write` |
| POST | `/api/pms/reservations/:id/late-checkout` | `pms.reservation.checkout` (mode=LATE) | `pms.reservation.write` |

### Front Desk (read)
| Method | Path | Query | Permission |
|---|---|---|---|
| GET | `/api/pms/frontdesk/arrivals` | `pms.frontdesk.arrivals` | `pms.reservation.read` |
| GET | `/api/pms/frontdesk/departures` | `pms.frontdesk.departures` | `pms.reservation.read` |
| GET | `/api/pms/frontdesk/inhouse` | `pms.frontdesk.inhouse` | `pms.reservation.read` |

### Billing / Folio / Ledger (read)
| Method | Path | Query | Permission |
|---|---|---|---|
| GET | `/api/pms/folios` | `pms.folio.list` | `folio.read` |
| GET | `/api/pms/folios/:id` | `pms.folio.byId` (folio + lines) | `folio.read` |
| GET | `/api/finance/ledger` | `finance.ledger.by_reference` (alias) | `ledger.read` |

### Housekeeping (read)
| Method | Path | Query | Permission |
|---|---|---|---|
| GET | `/api/pms/housekeeping/tasks` | `pms.housekeeping.task.list` | `housekeeping.read` |
| GET | `/api/pms/housekeeping/room-status` | `pms.housekeeping.room_status` | `housekeeping.read` |

### Night Audit (read)
| Method | Path | Query | Permission |
|---|---|---|---|
| GET | `/api/pms/night-audit/status` | `pms.night_audit.status` (state + business date + lock) | `night_audit.read` |
| GET | `/api/pms/night-audit/history` | `pms.night_audit.history` | `night_audit.read` |

### IAM (read-only)
| Method | Path | Query | Permission |
|---|---|---|---|
| GET | `/api/iam/users` | `iam.users.list` (no password_hash) | `auth.user.create` |
| GET | `/api/iam/roles` | `iam.roles.list` | `auth.user.create` |

---

## Behavioural guarantees

- **Audit trail.** New writes emit domain events through the bus (audit + event
  store) carrying property id, actor id, request id, timestamp:
  `reservation.updated`, `reservation.room_moved` (+ `room.status_changed`), and
  checkout `mode` on `reservation.checked_out`.
- **Availability / room validation on move + check-in.** `room_move` verifies the
  target room exists, belongs to the property, and is not `OCCUPIED`; it frees the
  old room (`VACANT_DIRTY`) and occupies the new one. Check-in already validates the
  assigned room (unchanged).
- **Invalid-state prevention.** `update` is allowed only for `INQUIRY/OPTION/CONFIRMED`;
  `room_move` requires `CHECKED_IN`; check-in still requires `CONFIRMED` (so
  `CHECKED_OUT → CHECKED_IN` remains blocked). Checkout variants require `CHECKED_IN`.
- **No new business rules** beyond what each missing endpoint required; checkout
  variants reuse the existing checkout command and only tag the audit `mode`.
- **Schema compatibility.** Folio detail returns `{ ...folio, lines: [...] }`
  (`asObject`); all list endpoints return arrays (`asArray`); ledger entries keep the
  existing `finance.ledger.by_reference` shape.

---

## Missing API Closure Report — frontend gap → backend endpoint → status

| Phase 20A frontend gap | Backend endpoint now available | Status |
|---|---|---|
| Reservation edit/modify (no route) | `PUT /api/pms/reservations/:id` | ✅ done |
| Room move (no route) | `POST /api/pms/reservations/:id/room-move` | ✅ done |
| Early / late / force checkout (no route) | `…/early-checkout`, `…/late-checkout`, `…/force-checkout` | ✅ done |
| Front Desk lists derived client-side | `GET /api/pms/frontdesk/{arrivals,departures,inhouse}` | ✅ done |
| Folio list/detail (no read route) | `GET /api/pms/folios`, `GET /api/pms/folios/:id` | ✅ done |
| Ledger lookup convenience path | `GET /api/finance/ledger?reference_type=&reference_id=` | ✅ done |
| Housekeeping task list (no read) | `GET /api/pms/housekeeping/tasks` | ✅ done |
| Housekeeping room status (no read) | `GET /api/pms/housekeeping/room-status` | ✅ done |
| Night audit status (no read) | `GET /api/pms/night-audit/status` | ✅ done |
| Night audit history (no read) | `GET /api/pms/night-audit/history` | ✅ done |
| Admin user list (no read) | `GET /api/iam/users` | ✅ done |
| Admin role list (no read) | `GET /api/iam/roles` | ✅ done |

---

## Success criteria

- ✅ **No remaining "no route" gaps** from the Phase 20A audit — every gap now has a
  callable backend route.
- ✅ **All Phase 20A gaps resolved at the API level.**
- ✅ **Frontend can operate without mock/fallback logic** — all required reads/writes
  exist and return `unwrap`/`asArray`/`asObject`-compatible shapes. (Frontend wiring
  to adopt these is a separate phase; this phase changed backend only.)
- ✅ No backend regressions: 455 server unit tests pass.

## Files changed
- `db/repos.js` — `updateReservation`, `reassignReservationRoom`, `listFolios`,
  `listRuns`, `listUsers`, `listRoles`.
- `commands/pms/index.js` — `pms.reservation.update`, `pms.reservation.room_move`.
- `commands/pms/checkinFolio.js` — checkout `mode` audit tag.
- `queries/pms/index.js` — front-desk, folio, housekeeping, night-audit reads.
- `queries/iam/index.js` *(new)* — `iam.users.list`, `iam.roles.list`.
- `routes/pms.js`, `routes/finance.js`, `routes/iam.js` *(new)*, `routes/api.js` — route wiring.
- `index.js` — pass `housekeepingRepo`/`nightAuditRepo` to pms queries; register IAM queries.
- `test/_fixtures.js`, `test/pms_phase21_exposure.test.js` — fakes + coverage.
