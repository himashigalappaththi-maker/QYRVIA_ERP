# QYRVIA Phase 26.1 — Booking Engine Permission Review (Report Only)

**Question:** should the Booking Engine routes keep `pms.reservation.write`, or introduce dedicated
`booking.create` / `booking.update` / `booking.cancel` permissions?
**Mode:** recommendation only. **No code / UI / schema changes.**

---

## 0. As-built RBAC facts (verified)

| Fact | Evidence |
|---|---|
| Permission catalog gates reservation writes with **one coarse code** | `0021_pms_permissions.sql`: only `pms.reservation.read` + `pms.reservation.write` ("Create / confirm / cancel / no-show reservations") |
| `pms.reservation.create/update/cancel` are **command names, not permissions** | command defs gate via `permission: 'pms.reservation.write'` |
| Booking Engine route + underlying commands gate on the **same** permission today | route `pms.reservation.write` → `BookingService` → `commandBus.dispatch('pms.reservation.create')` (also `pms.reservation.write`) |
| Roles with reservation write | `corporate_admin`, `property_admin`, `front_office_manager` (super_admin bypasses) |
| Read-only roles | `supervisor`, `staff` |
| **No Sales role exists** | `0003_seed_roles.sql` (10 roles; none sales/reservations-agent) |
| Group bookings already use a **separate** permission | `reservation.group.write` |
| Middleware | super roles bypass; wildcard (`*`, `*_admin`) supported |

**Critical observation:** authorization in QYRVIA gates the **capability** (reservation write), not the
**entry channel**. The Booking Engine, OTA inbound (B8-B4), and Front Desk all reach the *same*
`pms.reservation.*` commands, all gated by `pms.reservation.write`.

---

## 1. RBAC granularity
- Today reservation writes are **coarse**: `pms.reservation.write` covers create/confirm/cancel/no-show.
- A dedicated `booking.create/update/cancel` namespace would be **finer at the route**, but the
  **commandBus still gates on `pms.reservation.write`** — producing a **split gate**: a principal could
  pass `booking.create` yet be denied at `pms.reservation.create` (or vice-versa). That is a
  correctness + audit hazard, not granularity.
- True granularity requires splitting **both layers** into `pms.reservation.create` /
  `pms.reservation.cancel` *permissions* — i.e., refine the existing namespace, not add a parallel one.
- **Verdict:** a `booking.*` namespace adds apparent granularity while creating real inconsistency.

## 2. Future AI agent compatibility
- An AI WhatsApp agent is an automated actor; least-privilege says it should be able to **create**
  bookings without holding full `pms.reservation.write` (which also lets it cancel/no-show arbitrary
  reservations).
- This is the **strongest argument for granularity** — but it points to splitting the *capability*
  (`pms.reservation.create` as a real permission at route **and** command), grantable to an `ai_agent`
  role, **not** to a `booking.*` channel namespace.
- **Verdict:** favors a future `pms.reservation.create` permission; does **not** favor `booking.*`.

## 3. OTA webhook compatibility
- Inbound OTA (B8-B4) dispatches `pms.reservation.create` via commandBus under the webhook principal;
  the route is gated `channel.sync.run`, the command by `pms.reservation.write`.
- If booking creation required a new `booking.create`, the OTA principal would need it **too**, or OTA
  ingestion breaks. Keeping the **command gate** as `pms.reservation.write` (or a future
  `pms.reservation.create`) keeps Booking Engine + OTA + Front Desk **consistent at one capability**.
- **Verdict:** a channel-specific `booking.*` permission would fragment the shared command path.

## 4. Front Desk role separation
- `front_office_manager` already holds `pms.reservation.write` and should book. A `booking.create`
  would simply be granted to them too — **no separation gained**.
- **Verdict:** no need.

## 5. Sales role separation
- **No Sales role exists today.** *If* one is added that may create bookings but not cancel/no-show
  existing reservations, granularity matters — satisfied by `pms.reservation.create` vs
  `pms.reservation.cancel` permissions, grantable per role.
- **Verdict:** future-conditional; argues for refining `pms.reservation.*`, not `booking.*`.

## 6. Corporate booking workflows
- Corporate bookings are reservations with a company/agent holder; `corporate_admin`/`property_admin`
  already cover them. No distinct permission needed for v1.
- **Verdict:** no change.

## 7. Group booking workflows
- The system **already** separates group operations via `reservation.group.write` — precedent that a
  *distinct capability with distinct risk* earns its own permission. Group is the model: not a
  channel namespace, but a capability namespace under `reservation.*`.
- **Verdict:** reinforces "split by capability, in the existing namespace," not by entry channel.

---

## 8. Recommendation

### 8.1 Now (Phase 26): **KEEP `pms.reservation.write`** on the Booking Engine routes.
Rationale: (a) it matches the commandBus gate the same writes already pass through (no split-gate
hazard); (b) it keeps Booking Engine, OTA inbound, and Front Desk authorized by **one capability**;
(c) no current role needs create-only-not-cancel separation; (d) zero schema/seed churn.

### 8.2 Do **NOT** introduce a `booking.create/update/cancel` namespace.
It conflates **entry channel** (Booking Engine) with **capability** (reservation write). Permissions
must gate the capability — the same action must not be authorized differently depending on which door
(UI / OTA / AI) it entered through, or audit + least-privilege both break.

### 8.3 Future (when a Sales or AI-agent role lands): refine the **existing** namespace.
Introduce real sub-permissions **at both route and command layers**, mirroring `reservation.group.write`:
- `pms.reservation.create` — create/book (grant to Front Desk, Sales, AI agent, OTA principal)
- `pms.reservation.cancel` — cancel/no-show (withhold from create-only actors)
- `pms.reservation.update` — modify (as needed)
Keep `pms.reservation.write` as a **composite/legacy alias** (wildcard-friendly) so existing roles keep
working during migration. This is additive and backward-compatible; the Booking Engine route would then
adopt `pms.reservation.create` on `/create`, `pms.reservation.update` on `/update/:id`, and
`pms.reservation.cancel` on `/cancel/:id` — **in lockstep with the command permissions**, never ahead.

### 8.4 Migration sketch (logical only — not executed)
1. Seed `pms.reservation.{create,update,cancel}` permissions; grant to roles that hold
   `pms.reservation.write` today (no behavior change).
2. Update reservation **command** `permission:` from `pms.reservation.write` to the specific verb.
3. Update Booking Engine + OTA + Front Desk **routes** to the matching verb (same commit as step 2).
4. Add `ai_agent` / `sales` roles with create-only grants.
5. Retain `pms.reservation.write` as an alias until all consumers move.

---

## 9. Summary

| Criterion | Pull toward dedicated perms? | Conclusion |
|---|:---:|---|
| RBAC granularity | weak (split-gate hazard) | keep coarse now |
| AI agent | **yes** | future `pms.reservation.create`, not `booking.*` |
| OTA webhook | no (would fragment shared path) | keep one capability |
| Front Desk | no | no separation gained |
| Sales | future-yes | refine `pms.reservation.*` |
| Corporate | no | covered |
| Group | precedent (capability namespace) | split by capability, not channel |

**Bottom line:** **retain `pms.reservation.write` for Phase 26.** Reject a `booking.*` namespace.
When least-privilege actors (Sales / AI agent) arrive, split the **`pms.reservation.*` capability**
(create / update / cancel) at route **and** command together, with `pms.reservation.write` kept as a
backward-compatible alias.

**No code, UI, or schema changes were made. Report only.**
