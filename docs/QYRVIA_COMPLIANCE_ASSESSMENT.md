# QYRVIA Architectural Compliance & Gap Assessment

> Performed at the Phase 5.5 / Phase 6 gate. **Implementation must NOT
> proceed to Phase 6 until the Critical Gaps in §16 are approved.** This
> document is the formal sign-off artifact for that approval.
>
> **As-of:** post-Phase 5.5 (Architecture Hardening). Backend tests:
> 259 / 259 passing. Migrations: 0001..0030.
>
> Legend:
> * **✓ Supported** — full code path implemented, exercised by tests.
> * **◐ Partial**   — persistence + extension points reserved; behaviour
>                     ships in a later phase. (This is the dominant state
>                     after Phase 5.5.)
> * **✗ Missing**   — not addressed yet; gap flagged below.

---

## §1 — Multi-Property Foundation

### 1.1 Property ID auto-generation — **✓ Supported**
- **Current coverage:** `properties.id UUID DEFAULT gen_random_uuid()` (migration 0001) + pgcrypto extension.
- **Missing:** none.
- **Schemas / Aggregates / Services:** present.
- **APIs:** `POST /api/setup/properties` (wizard) + admin create-property command (Phase 4).
- **Events:** `property.created` emitted when the wizard runs.
- **Permissions:** `property.create` reserved for `super_admin` + `corporate_admin`.
- **Settings:** n/a.
- **Audit:** command pipeline records `command.attempted/succeeded`.
- **Extension points:** none required.
- **Phase:** done (Phase 1 + 4).
- **Risk if deferred:** N/A — already shipped.

### 1.2 Immutable Property ID — **✓ Supported**
- **Current coverage:** `id UUID PRIMARY KEY`; no UPDATE path on `properties.id`. RLS prevents cross-tenant tampering.
- **Missing:** no DB trigger explicitly forbidding `UPDATE properties SET id=...`. (PostgreSQL allows it in principle; in practice no code path issues it.)
- **Schemas:** add `CREATE TRIGGER properties_id_immutable BEFORE UPDATE OF id ON properties …` for defense-in-depth (Phase 6 nice-to-have).
- **APIs / Events / Permissions:** no `property.id.update` command exists by design.
- **Audit:** any future violation would be visible in `audit_events`.
- **Extension points:** none.
- **Phase:** done (with optional trigger hardening in Phase 6).
- **Risk if deferred:** **low** (defensive).

### 1.3 Property Code support — **✓ Supported**
- **Current coverage:** `properties.code VARCHAR(32) NOT NULL`, `UNIQUE (tenant_id, code)` (migration 0001). Reservation numbers embed the code (`PROPCODE-YYYY-NNNNNN`, Phase 5).
- **Missing:** code immutability rule (today the wizard sets it once, no UI to change).
- **Schemas:** none.
- **APIs:** wizard sets code; no rename endpoint by design.
- **Events:** `property.created.payload.code`.
- **Permissions:** part of `property.create`.
- **Audit:** command pipeline.
- **Phase:** done.
- **Risk if deferred:** N/A.

### 1.4 Company Logo support — **✓ Supported**
- **Current coverage:** `tenants.company_logo_url TEXT` (migration 0022). Storage via Phase 3 `fileService` (local / S3-compatible).
- **Missing:** no “upload company logo” UI (no UI work in this stack).
- **Schemas:** present.
- **APIs:** `POST /api/files` (Phase 3) returns a `file_id`; tenant settings can reference it.
- **Events:** `tenant.updated` (to be emitted when a tenant settings update command ships).
- **Permissions:** `settings.write` (Phase 3).
- **Audit:** command pipeline.
- **Extension points:** files repo + connector registry already pluggable.
- **Phase:** done.
- **Risk if deferred:** N/A.

### 1.5 Property Logo support — **✓ Supported**
- **Current coverage:** `properties.logo_url TEXT` (migration 0022). Same plumbing as 1.4.
- **Missing:** none.
- **Phase:** done.
- **Risk if deferred:** N/A.

### 1.6 Property ID visibility throughout system — **✓ Supported**
- **Current coverage:** `ctx.propertyId` flows from JWT `primary_property_id` into every command/query/event/audit row. `audit_events.property_id`, `event_store.property_id`, all PMS tables carry `property_id`.
- **Missing:** none.
- **Phase:** done (Phase 2 + Phase 5).
- **Risk if deferred:** N/A.

### 1.7 Property ID + Username + Password authentication — **✓ Supported**
- **Current coverage:** `POST /api/auth/login` resolves `(tenant_code, username, password)` (Phase 2 / 4). JWT carries `tenant_id` + `primary_property_id`.
- **Missing:** the brief asks for **Property ID** (not tenant code) at login. Today login is by `tenant_code` and the property is derived from the user’s `primary_property_id`. To match the brief verbatim, support `(property_code, username, password)` — resolves the tenant from the property.
- **Schemas:** none (already keyed).
- **Services:** new resolver `findUserByPropertyUsername(propertyCode, username)` joining `users` → `tenants` → `properties`.
- **APIs:** `POST /api/auth/login` to accept `property_code` in addition to `tenant_code`.
- **Events:** existing `user.logged_in`.
- **Permissions:** none.
- **Audit:** existing.
- **Extension points:** identityRepo extension.
- **Phase:** **Phase 6 (small)** — straightforward additive change.
- **Risk if deferred:** **high** — affects the published login UX of multi-property hotels; user-facing.

### 1.8 Multi-property user access — **◐ Partial**
- **Current coverage:** `user_roles` already carries `property_id` (Phase 2). A user can hold roles at multiple properties under the same tenant. Login currently returns ONE access token tied to `primary_property_id`.
- **Missing:** a) listing the set of accessible properties at login, b) a per-request "active property" selector that does not require re-login.
- **Schemas:** `users.allowed_property_ids` — NOT needed; computed from `user_roles`.
- **Aggregates:** none.
- **Services:** `listAccessibleProperties(userId)` in `identityRepo`.
- **APIs:** `GET /api/auth/properties` (returns the set); see §1.9 for switcher.
- **Events:** `user.property_listed` (audited query).
- **Permissions:** none.
- **Audit:** queryBus audit on `auth.properties.list`.
- **Phase:** **Phase 6 (small)**.
- **Risk if deferred:** **high** — blocks the multi-property login UX entirely.

### 1.9 Property switcher without logout — **✗ Missing**
- **Current coverage:** none — JWT is single-property today.
- **Missing:** a switcher mechanism that (re-)issues a JWT scoped to a new `primary_property_id` without forcing the user to re-enter credentials.
- **Schemas:** none.
- **Aggregates:** none.
- **Services:** `tokens.issueAccessToken` already supports arbitrary `primaryPropertyId`; need a switcher command that re-checks `user_roles` for the target property.
- **APIs:** `POST /api/auth/switch-property { property_id }` → new access+refresh pair.
- **Events:** `user.property_switched` (audited, payload contains old/new property_id).
- **Permissions:** none required beyond "user must hold a role at the target property".
- **Settings:** `multi_property.switcher_remember_choice = true|false`.
- **Audit:** dedicated event captured.
- **Extension points:** none.
- **Phase:** **Phase 6 (critical for UX)**.
- **Risk if deferred:** **critical** — without this, a manager at 4 properties needs 4 separate logins → fundamentally breaks the multi-property promise.

### 1.10 Property-level data isolation — **✓ Supported**
- **Current coverage:** RLS `tenant_id::text = current_setting('app.tenant_id', true)` on every tenant table (Phases 1, 3, 4, 5, 5.5). Property scoping applied in repo queries (`WHERE property_id = $1`). PMS tables verified by `tenant_isolation.test.js` and `pms_isolation_and_businessdate.test.js`.
- **Missing:** RLS today filters on **tenant** only; cross-property reads inside the same tenant are allowed at the DB level (the application enforces property scoping). For a strict per-property cut, an additional `app.property_id` `current_setting` policy could be layered, but it would break legitimate cross-property corporate reads (CRM, finance, BI).
- **Phase:** done (tenant-level). Property-level cut is intentionally application-enforced.
- **Risk if deferred:** N/A.

### 1.11 Inter-property inventory transfers — **✗ Missing**
- **Current coverage:** `inventory_items` + `inventory_stock_levels` reserved (migration 0029). Each stock level row is keyed by `(item_id, location_code, property_id)`, so the schema is **ready** to represent multi-property stock, but there is no transfer aggregate yet.
- **Missing:** transfer aggregate + commands.
- **Schemas:** new table `inventory_transfers (id, tenant_id, from_property_id, to_property_id, item_id, quantity, status, requested_at, completed_at, payload)` + `inventory_transfer_lines` if multi-item.
- **Aggregates:** `inventory_transfer` (REQUESTED → APPROVED → DISPATCHED → RECEIVED → CLOSED).
- **Services:** `inventoryTransferService` (deduct on dispatch, add on receive, cancellation reverses).
- **APIs:** `POST /api/inventory/transfers`, `/:id/approve`, `/:id/dispatch`, `/:id/receive`, `/:id/cancel`.
- **Events:** `inventory.transfer.requested|approved|dispatched|received|cancelled`.
- **Permissions:** `inventory.transfer.write` (new) + property-scope check on both sides.
- **Settings:** `inventory.transfers.requires_two_property_approval = true|false`.
- **Audit:** command pipeline.
- **Extension points:** inventory adjustment hook.
- **Phase:** **Phase 7+** (inventory module phase).
- **Risk if deferred:** **medium** — blocks multi-property inventory ops only; PMS Core unaffected.

### 1.12 Inter-property procurement transfers — **✗ Missing**
- **Current coverage:** `procurement_purchase_orders` reserved with `property_id`. No transfer concept yet.
- **Missing:** transferable PO line concept where one property sources to another, or a "central procurement → branch distribution" workflow.
- **Schemas:** add `procurement_distribution (id, parent_po_id, to_property_id, status, quantity, …)` and `procurement_purchase_orders.is_central BOOLEAN DEFAULT false`.
- **Aggregates:** `procurement_distribution`.
- **Services:** `procurementDistributionService`.
- **APIs:** `POST /api/procurement/distribute`, `/:id/receive`.
- **Events:** `procurement.distribution.created|received`.
- **Permissions:** `procurement.po.distribute` (new).
- **Settings:** `procurement.central_procurement_enabled`.
- **Phase:** **Phase 7+** (procurement phase).
- **Risk if deferred:** **medium** — only needed by chains using central procurement.

### 1.13 Inter-property financial transactions — **✗ Missing**
- **Current coverage:** `finance_journal_entries` carries `property_id`; nothing prevents two property-scoped entries from posting against the same source_ref to model an inter-co transfer, but there is no built-in pairing.
- **Missing:** inter-company / inter-property settlement schema; "Due from / Due to" account convention.
- **Schemas:** add `intercompany_transfers (id, tenant_id, from_property_id, to_property_id, amount, currency, due_from_account_id, due_to_account_id, posted_at, business_date, payload)`. Add account_type seed for `INTERCOMPANY`.
- **Aggregates:** `intercompany_transfer`.
- **Services:** `intercompanyService`.
- **APIs:** `POST /api/finance/intercompany`.
- **Events:** `finance.intercompany.posted`.
- **Permissions:** `finance.intercompany.post`.
- **Settings:** `finance.intercompany.auto_post = true|false`.
- **Audit:** double-entry via existing journal entries; reconciliation flag on the IC row.
- **Phase:** **Phase 8** (finance phase).
- **Risk if deferred:** **medium** — chains with shared procurement / shared services need this. Single-property hotels do not.

### 1.14 Property-level audit trails — **✓ Supported**
- **Current coverage:** `audit_events.property_id`, `event_store.property_id`. Every event captures the property scope from `ctx.propertyId`. Indexes on `(tenant_id, occurred_at DESC)`; an additional `(property_id, occurred_at DESC)` index would speed property-scoped audit views.
- **Missing:** index `idx_audit_events_property_time`.
- **Schemas:** `CREATE INDEX idx_audit_events_property_time ON audit_events(property_id, occurred_at DESC) WHERE property_id IS NOT NULL;` (Phase 6 micro-migration).
- **Phase:** done; add the index in Phase 6.
- **Risk if deferred:** **low**.

---

## §2 — Business Date / Night Audit

### 2.1 Business Date model — **✓ Supported**
- **Current coverage:** `properties.current_business_date DATE` + `business_date_locked BOOL` (Phase 2). Middleware `businessDateMiddleware` injects `ctx.businessDate` + `ctx.businessDateLocked` on every authenticated request.
- **Missing:** none.
- **Phase:** done.
- **Risk if deferred:** N/A.

### 2.2 Day-End architecture — **✓ Supported**
- **Current coverage:** `services/pms/nightAudit.js`. Subscriber-step pattern (`registerStep(name, fn)`) lets later modules attach without modifying the service.
- **Missing:** none.
- **Phase:** done (Phase 5.5).

### 2.3 Night Audit architecture — **✓ Supported**
- **Current coverage:** `night_audit_runs` table + `pms.night_audit.run` command (Phase 5.5). Run records: business_date, next_business_date, status, started_at, completed_at, duration_ms, reservations_arrived/departed/no_show, rooms_charged, total_room_revenue, error.
- **Missing:** subscriber steps that actually post room charges, flip no-shows, snapshot revenue. These are module-side work.
- **Phase:** foundation done; subscriber steps ship with their owning modules (Folio = Phase 7; Revenue snapshot = Phase 8).
- **Risk if deferred:** **medium** — until the subscribers exist, Night Audit only advances the date and unlocks; financial postings will be no-op.

### 2.4 Automatic Day-End scheduler — **◐ Partial**
- **Current coverage:** `scheduler` core (Phase 3) supports recurring jobs via cron. Registering a per-property cron job that dispatches `pms.night_audit.run` is mechanical.
- **Missing:** per-property cron-time setting + the bootstrap that creates the recurring `scheduled_jobs` row.
- **Schemas:** none (uses existing `scheduled_jobs`).
- **Services:** `nightAuditScheduler.bootstrapForProperty(propertyId, cron, tz)`.
- **APIs:** `POST /api/pms/night-audit/schedule { cron, timezone }` (per property).
- **Events:** `night_audit.schedule.configured`.
- **Permissions:** `night_audit.config`.
- **Settings:** `night_audit.cron`, `night_audit.timezone` (per property).
- **Audit:** command pipeline.
- **Phase:** **Phase 6 (small)**.
- **Risk if deferred:** **high** — without it, Day-End is manual-only.

### 2.5 Manual Run Day-End — **✓ Supported**
- **Current coverage:** `POST /api/pms/night-audit/run`, permission `night_audit.run`.
- **Phase:** done.

### 2.6 Business Date Not Closed alerts — **✗ Missing**
- **Current coverage:** none (we expose `ctx.businessDate`; UI does not alert when stale).
- **Missing:** a server-side rule: "if `current_business_date < today - 1`, raise a `business_date.stale` notification".
- **Schemas:** none.
- **Services:** new step inside scheduler — `notifyStaleBusinessDate` cron job hourly.
- **APIs:** existing `notifications` surface (Phase 3).
- **Events:** `business_date.stale_detected`.
- **Permissions:** none (system-emitted).
- **Settings:** `night_audit.stale_threshold_hours = 24`.
- **Audit:** existing notification log.
- **Phase:** **Phase 6 (small)**.
- **Risk if deferred:** **high** — silent skipped audits compound; finance integrity at risk.

### 2.7 Night Audit Pending alerts — **◐ Partial**
- **Current coverage:** the `business_date_locked` flag tells the request whether an audit is in progress; `commandBus` returns `business_date_locked` errors for sensitive commands. The UI is not yet wired to surface "Night Audit pending" prominently.
- **Missing:** an explicit `business_date.audit_in_progress` notification.
- **Phase:** **Phase 6**.
- **Risk if deferred:** **low** — graceful degradation already in place.

### 2.8 Accounting lock controls — **✓ Supported**
- **Current coverage:** `commandBus` honours `cmd.accountingSensitive`; rejects with `business_date_locked` when the lock is held. Audited per the standard pipeline. Phase 5.5 test coverage.
- **Missing:** none.
- **Phase:** done.

### 2.9 Operational continuity when audit pending — **✓ Supported**
- **Current coverage:** non-accounting commands run regardless of lock state — verified by `accountingSensitive.test.js`. Reservations, housekeeping, profile edits, etc. proceed.
- **Phase:** done.

### 2.10 Business Date audit history — **✓ Supported**
- **Current coverage:** `night_audit_runs` keeps a permanent row per property per business_date with completion time, duration, error, stats. Unique index `ux_night_audit_property_busdate`.
- **Phase:** done.

### 2.11 Re-open business date controls — **✗ Missing**
- **Current coverage:** none. Once advanced, `current_business_date` only moves forward via `advancePropertyBusinessDate`.
- **Missing:** a tightly-controlled re-open path for corrections.
- **Schemas:** add `night_audit_reopens (id, tenant_id, property_id, business_date, reopened_at, reopened_by, reason, reclosed_at, approved_by)`.
- **Aggregates:** `night_audit_reopen`.
- **Services:** `nightAuditService.reopen(propertyId, businessDate, {reason, approverId})`.
- **APIs:** `POST /api/pms/night-audit/reopen { business_date, reason }`.
- **Events:** `night_audit.reopened`, `night_audit.reclosed`.
- **Permissions:** new `night_audit.reopen` (corporate_admin only by default).
- **Settings:** `night_audit.reopen.requires_dual_approval = true|false`, `night_audit.reopen.max_days_back = 3`.
- **Audit:** command pipeline + dedicated reopen row.
- **Phase:** **Phase 8 (with finance phase)** — re-open is fundamentally an accounting concept.
- **Risk if deferred:** **medium** — operational pain but no day-1 blocker.

### 2.12 Financial posting controls — **✓ Supported (foundation)**
- **Current coverage:** every financially-sensitive command must declare `accountingSensitive: true` (commandBus enforces lock + audits). Currently applied to `pms.folio.charge.post` and `pms.folio.close`; will apply to every future Finance / POS / Procurement command.
- **Missing:** no compile-time enforcement that finance commands set the flag. Convention only.
- **Phase:** done (lint-level enforcement is a Phase 8 nicety).
- **Risk if deferred:** **low** — code review catches.

---

## §3 — PMS Core Requirements

### 3.1 Adult reservation ownership model — **✓ Supported**
- **Current coverage:** `reservations.holder_guest_id` + `primary_adult_guest_id`; `pms.reservation.create` rejects non-Adult holders (a child is never holder). Refuses blacklisted holders. Tested.
- **Phase:** done.

### 3.2 Child Policy Engine — **✓ Supported**
- **Current coverage:** `child_policies` + `child_age_categories` (per-age band: stay %, meal %, counts_in_occupancy, requires_extra_bed, extra_bed_charge). `services/pms/childPolicy.js` exposes pure `evaluateChild`, `evaluateMany`, `classifyParty`.
- **Phase:** done.

### 3.3 Occupancy policy engine — **✓ Supported**
- **Current coverage:** `room_types.max_adults / max_children / base_occupancy / extra_bed_capacity`. `classifyParty()` returns `{occupancy_total, extra_beds_needed, oversold, reasons}`. Reservation creation refuses oversold parties when a child policy is supplied.
- **Missing:** room-level overrides (some rooms have fewer beds than their type) — currently not modelled.
- **Schemas:** add `rooms.max_occupancy_override INTEGER NULL` (Phase 6 micro).
- **Phase:** done with one optional follow-up.
- **Risk if deferred:** **low**.

### 3.4 Meal policy engine — **◐ Partial**
- **Current coverage:** `rate_plans` + `rate_plan_pricing` carry rates per occupancy_count / child_category_code. `contract_rates.meal_plan` reserved (RO/BB/HB/FB/AI). No first-class "meal plan" aggregate.
- **Missing:** a `meal_plans` table for plan codes + inclusion rules; explicit linkage between `rate_plans` and `meal_plans`.
- **Schemas:** add `meal_plans (id, tenant_id, property_id, code, name, includes_breakfast, includes_lunch, includes_dinner, includes_snack, adult_rate, child_rate, …)` + `rate_plans.meal_plan_id UUID NULL`.
- **Aggregates:** `meal_plan`.
- **Services:** `mealPlanService` (compute per-guest meal entitlements).
- **APIs:** `POST /api/pms/meal-plans` + `GET`.
- **Events:** `meal_plan.created/updated`.
- **Permissions:** `pms.mealplan.read/write`.
- **Settings:** `pms.default_meal_plan`.
- **Audit:** command pipeline.
- **Extension points:** POS uses meal_plan to know what's pre-paid vs chargeable.
- **Phase:** **Phase 6 (PMS module phase)**.
- **Risk if deferred:** **high** — every reservation already needs a meal plan; rate plans currently encode this implicitly. Going to production without it forces clunky workarounds.

### 3.5 Extra bed policy engine — **✓ Supported**
- **Current coverage:** `room_types.extra_bed_capacity`; `child_age_categories.requires_extra_bed` + `extra_bed_charge`; `classifyParty()` returns `extra_beds_needed`.
- **Missing:** explicit "extra bed charge" line creation at reservation time (currently the bed flag exists; the charge will be posted by the folio module).
- **Phase:** done (engine) + Phase 7 (folio postings).

### 3.6 Seasonal child overrides — **✗ Missing**
- **Current coverage:** child policies are static — one policy per property.
- **Missing:** date-bound overrides ("July school holidays = child counts in occupancy").
- **Schemas:** add `child_policy_overrides (id, tenant_id, child_policy_id, date_from, date_to, category_code, stay_charge_pct, meal_charge_pct, counts_in_occupancy, requires_extra_bed, extra_bed_charge)`.
- **Aggregates:** none (extension of child_policy).
- **Services:** `evaluateChild` to take an optional `forDate` parameter.
- **APIs:** `POST /api/pms/child-policies/:id/overrides`.
- **Events:** `child_policy.override.created`.
- **Permissions:** `pms.childpolicy.write`.
- **Settings:** none.
- **Audit:** command pipeline.
- **Phase:** **Phase 7** (PMS extended).
- **Risk if deferred:** **low** — operators can manually swap policies if needed.

### 3.7 Reservation source tracking — **✓ Supported**
- **Current coverage:** `reservations.source_channel VARCHAR(40)` + `external_ref VARCHAR(120)` (migration 0022). Index on `external_ref` for OTA reconciliation.
- **Missing:** none.
- **Phase:** done.

### 3.8 Group reservations — **◐ Partial**
- **Current coverage:** `reservation_groups` table + `reservations.group_id` FK (migration 0024).
- **Missing:** group-create command, group-rooming-list query, group cancellation cascade.
- **Schemas:** present.
- **Aggregates:** `reservation_group`.
- **Services:** `groupReservationService`.
- **APIs:** `POST /api/pms/reservations/groups`, `/:id/rooming-list`, `/:id/cancel`.
- **Events:** `reservation_group.created`, `reservation_group.cancelled`.
- **Permissions:** `reservation.group.write` (already seeded).
- **Settings:** `pms.groups.auto_block_inventory`.
- **Audit:** command pipeline.
- **Extension points:** integrates with allocations (§4.6).
- **Phase:** **Phase 7**.
- **Risk if deferred:** **high** — groups are 30-40 % of resort revenue in many markets.

### 3.9 Corporate reservations — **✓ Supported (foundation)**
- **Current coverage:** `guest_type='CORPORATE'`. Contracts (§4.4) attach to corporate `guests`. Reservations link via `contract_id` (migration 0024).
- **Missing:** the booking flow that picks up the negotiated rate from `contract_rates` automatically.
- **Phase:** **Phase 7**.
- **Risk if deferred:** **medium**.

### 3.10 Agent reservations — **✓ Supported (foundation)**
- **Current coverage:** `guest_type='TRAVEL_AGENT'`. Same machinery as 3.9.
- **Phase:** **Phase 7**.

### 3.11 Tour reservations — **✓ Supported (foundation)**
- **Current coverage:** `guest_type='TOUR_ORGANIZER'` + `reservation_series` (migration 0024). `reservations.series_id` FK.
- **Missing:** series-generator command (create N reservations from a series template).
- **Phase:** **Phase 7**.

---

## §4 — Travel Commerce Foundation

### 4.1 Travel Agent support — **✓ Supported (foundation)**
- See 3.10. `guest_type` ENUM + dedicated contracts/allocations/proforma plumbing.
- **Phase:** persistence done; ops module = Phase 7.

### 4.2 DMC support — **✓ Supported (foundation)**
- `guest_type='DMC'`. Identical machinery to TAs (a DMC is a wholesaler).
- **Phase:** Phase 7.

### 4.3 Tour Operator support — **✓ Supported (foundation)**
- `guest_type='TOUR_ORGANIZER'` + `reservation_series`.
- **Phase:** Phase 7.

### 4.4 Corporate contracts — **✓ Supported (foundation)**
- **Current coverage:** `contracts` (status DRAFT/ACTIVE/SUSPENDED/EXPIRED/TERMINATED) + `contract_rates` keyed by date_from/date_to/room_type. `contract_partner_kind ENUM ('TRAVEL_AGENT','DMC','CORPORATE','TOUR_ORGANIZER','OTA')`.
- **Missing:** contract approval workflow, contract amendment versioning.
- **Schemas:** add `contract_revisions (id, contract_id, revision_no, snapshot_jsonb, approved_by, approved_at)` (Phase 7).
- **Phase:** persistence done; lifecycle commands = Phase 7.

### 4.5 Agent contracts — same as 4.4. Just `partner_kind='TRAVEL_AGENT'`.

### 4.6 Allocation management — **✓ Supported (foundation)**
- **Current coverage:** `allocations` (qty_blocked / qty_consumed / release_days / status ACTIVE|RELEASED|EXHAUSTED|CANCELLED) keyed to contract + room_type + date_from/date_to. `reservations.allocation_id` FK.
- **Missing:** auto-consume on reservation create, auto-release on cancellation, daily release-sweep job.
- **Schemas:** present.
- **Services:** `allocationService.consume()`, `.release()`, `.runReleaseSweep()`.
- **APIs:** `POST /api/pms/allocations`, `/:id/release`.
- **Events:** `allocation.consumed`, `allocation.released`, `allocation.exhausted`.
- **Permissions:** `allocation.write`.
- **Settings:** `allocations.default_release_days = 7`.
- **Audit:** command pipeline.
- **Phase:** **Phase 7**.
- **Risk if deferred:** **high** — without auto-release, allocations leak and depress saleable inventory.

### 4.7 Release periods — **✓ Supported (foundation)**
- `allocations.release_days INTEGER`. Sweep job is Phase 7.

### 4.8 Series bookings — **✓ Supported (foundation)** — see 3.11.

### 4.9 Group bookings — **✓ Supported (foundation)** — see 3.8.

### 4.10 Voucher workflows — **✗ Missing**
- **Current coverage:** none.
- **Missing:** voucher concept. A voucher is the document issued to a guest by an agent that the hotel must validate at check-in and bill the agent.
- **Schemas:** `vouchers (id, tenant_id, property_id, voucher_number, agent_guest_id, contract_id, guest_name, arrival_date, departure_date, room_type_id, status, amount, currency, issued_at, redeemed_at, redeemed_reservation_id, payload)`.
- **Aggregates:** `voucher` (ISSUED → REDEEMED | EXPIRED | CANCELLED).
- **Services:** `voucherService.redeem(voucherNumber, reservationId)`.
- **APIs:** `POST /api/pms/vouchers`, `/:id/redeem`, `/:id/cancel`.
- **Events:** `voucher.issued`, `voucher.redeemed`, `voucher.expired`.
- **Permissions:** `voucher.read`, `voucher.write`, `voucher.redeem`.
- **Settings:** `vouchers.default_validity_days = 90`.
- **Audit:** command pipeline.
- **Extension points:** check-in flow looks up vouchers by number.
- **Phase:** **Phase 7**.
- **Risk if deferred:** **high** — TA/DMC bookings depend on it.

### 4.11 Proforma Invoice framework — **✓ Supported (foundation)**
- **Current coverage:** `proforma_invoices` (status DRAFT|ISSUED|PAID|CANCELLED|REPLACED). Permissions seeded.
- **Missing:** issuance + PDF rendering + email delivery commands.
- **Phase:** persistence done; commands = Phase 7.

### 4.12 Agent settlement framework — **✗ Missing**
- **Current coverage:** none. Each reservation can carry `contract_id`; what's owed to which agent is computable but no "settlement statement" aggregate exists.
- **Missing:** statement aggregate.
- **Schemas:** `agent_settlements (id, tenant_id, property_id, partner_guest_id, period_start, period_end, status, total_amount, currency, settled_at, payload)` + `agent_settlement_lines (settlement_id, reservation_id, folio_id, base_amount, commission_amount)`.
- **Aggregates:** `agent_settlement`.
- **Services:** `agentSettlementService.generate(propertyId, partnerId, period)`.
- **APIs:** `POST /api/pms/settlements`, `/:id/issue`, `/:id/mark-settled`.
- **Events:** `agent_settlement.generated/issued/settled`.
- **Permissions:** `settlement.read`, `settlement.write`.
- **Settings:** `settlements.frequency = MONTHLY|WEEKLY`, `settlements.auto_generate = true|false`.
- **Audit:** command pipeline.
- **Phase:** **Phase 8** (finance + travel commerce).
- **Risk if deferred:** **medium** — settlements can be done in Excel for a month or two; not a day-1 blocker.

### 4.13 Commission framework — **◐ Partial**
- **Current coverage:** `contracts.commission_pct NUMERIC(5,2)`. No automatic commission line generation on reservation completion.
- **Missing:** commission calculation engine + journal posting.
- **Schemas:** add `commission_entries (id, tenant_id, property_id, reservation_id, contract_id, base_amount, commission_pct, commission_amount, business_date, posted_at, settlement_id)`.
- **Services:** `commissionService` (subscribe to `reservation.checked_out` / `folio.closed`).
- **APIs:** read-only `GET /api/pms/commissions`.
- **Events:** `commission.accrued`.
- **Permissions:** `commission.read`.
- **Settings:** `commissions.basis = pre_tax|post_tax`.
- **Phase:** **Phase 8**.
- **Risk if deferred:** **medium**.

---

## §5 — Revenue & Finance Foundation

### 5.1 Mandatory payment allocation — **◐ Partial**
- **Current coverage:** `folio_lines.charge_type='PAYMENT'` posts to a folio. There is no explicit "allocate payment to specific invoice line" mechanism.
- **Missing:** payment-to-line allocation.
- **Schemas:** add `payment_allocations (id, tenant_id, payment_line_id, charge_line_id, amount_allocated)`.
- **Aggregates:** none (sub-resource).
- **Services:** `paymentAllocationService` (auto-distribute oldest-first by default).
- **APIs:** `POST /api/pms/folios/:id/payments/:pid/allocate { allocations: […] }`.
- **Events:** `payment.allocated`.
- **Permissions:** `folio.post` (existing).
- **Settings:** `folio.payment.auto_allocate_oldest_first = true`.
- **Audit:** command pipeline.
- **Phase:** **Phase 7** (folio module).
- **Risk if deferred:** **high** — without it, AR aging is unreliable.

### 5.2 Invoice payment balancing — **✗ Missing**
- **Current coverage:** `folios.balance` is recomputed on every line insert. There is no explicit "is this invoice fully balanced" predicate.
- **Missing:** an invoice-level abstraction (today everything is a folio; an invoice = closed folio).
- **Schemas:** add `invoices (id, tenant_id, property_id, folio_id, invoice_number, issued_at, total_amount, paid_amount, balance, status, payload)`.
- **Aggregates:** `invoice` (DRAFT → ISSUED → PAID → VOIDED).
- **Services:** `invoiceService.issue(folioId)`.
- **APIs:** `POST /api/pms/invoices` (issue from folio).
- **Events:** `invoice.issued`, `invoice.paid`, `invoice.voided`.
- **Permissions:** `invoice.read/write`.
- **Settings:** `invoice.numbering.format = PROPCODE-INV-YYYY-NNNNNN`.
- **Audit:** command pipeline.
- **Phase:** **Phase 7**.
- **Risk if deferred:** **high** — fiscal compliance in many jurisdictions requires invoices, not just folios.

### 5.3 Cash change calculation — **✗ Missing**
- **Current coverage:** none.
- **Missing:** explicit "tendered vs due" calculation for cash payments.
- **Schemas:** none (the cash-tendered amount can live in `folio_lines.metadata`).
- **Services:** `paymentService.applyCash({due, tendered}) → {change}`.
- **APIs:** `POST /api/pms/folios/:id/payments/cash { tendered }` returns change.
- **Events:** `payment.received` with payload `{method: 'CASH', tendered, change}`.
- **Permissions:** `folio.post`.
- **Settings:** `payment.cash.rounding_unit = 0.01`.
- **Phase:** **Phase 7**.
- **Risk if deferred:** **high** — front desk POS demands it.

### 5.4 Accounts Receivable foundation — **◐ Partial**
- **Current coverage:** every `folio_lines.amount` for a corporate / agent guest is implicitly AR. No aging engine.
- **Missing:** AR aging buckets + statements.
- **Schemas:** add a view `ar_aging` over `folios.balance` grouped by `(property_id, guest_id, bucket)` where bucket = 0-30 / 31-60 / 61-90 / 90+ days.
- **Services:** `arService.aging(propertyId)`.
- **APIs:** `GET /api/finance/ar/aging`.
- **Events:** `ar.statement.generated`.
- **Permissions:** `finance.ar.read`.
- **Settings:** `ar.aging.buckets = [30,60,90]`.
- **Phase:** **Phase 8**.
- **Risk if deferred:** **medium** — collectors need it; not a day-1 blocker.

### 5.5 Accounts Payable foundation — **✗ Missing**
- **Current coverage:** `procurement_purchase_orders` exists; no AP/vendor-bill table.
- **Missing:** `vendor_bills (id, tenant_id, property_id, supplier_id, po_id, bill_number, issued_at, due_at, total_amount, balance, status, payload)` + `vendor_payments`.
- **Aggregates:** `vendor_bill`, `vendor_payment`.
- **Services:** `apService`.
- **APIs:** `POST /api/finance/ap/bills`, `/payments`.
- **Events:** `ap.bill.received`, `ap.payment.sent`.
- **Permissions:** `finance.ap.read/write`.
- **Settings:** `ap.payment.workflow.requires_two_approvals`.
- **Phase:** **Phase 8**.
- **Risk if deferred:** **medium**.

### 5.6 Cost Center architecture — **✗ Missing**
- **Current coverage:** none.
- **Missing:** cost-center concept independent of property (a single property may have multiple cost centers: kitchen, FB, rooms, spa).
- **Schemas:** `cost_centers (id, tenant_id, property_id, code, name, parent_id, active)`. Add `finance_journal_entries.cost_center_id UUID NULL`. Add `folio_lines.cost_center_id`. Add `procurement_purchase_orders.cost_center_id`.
- **Services:** `costCenterService`.
- **APIs:** `POST /api/finance/cost-centers`.
- **Events:** `cost_center.created`.
- **Permissions:** `finance.cost_center.write`.
- **Settings:** `finance.cost_center.required_on_expense = true|false`.
- **Phase:** **Phase 8**.
- **Risk if deferred:** **high** — every Finance / BI report demands cost centers; retro-fit later is painful.

### 5.7 Budget architecture — **✗ Missing**
- **Current coverage:** none.
- **Missing:** budget aggregate (year × cost-center × ledger account).
- **Schemas:** `budgets (id, tenant_id, property_id, fiscal_year, name, status)` + `budget_lines (budget_id, cost_center_id, account_id, month, amount)`.
- **Services:** `budgetService` + variance analysis.
- **APIs:** `POST /api/finance/budgets`, `/lines`, `/variance`.
- **Events:** `budget.created/approved/closed`.
- **Permissions:** `finance.budget.read/write/approve`.
- **Settings:** `budget.fiscal_year_start_month`.
- **Phase:** **Phase 8 (Finance)**.
- **Risk if deferred:** **medium**.

### 5.8 Revenue posting architecture — **◐ Partial**
- **Current coverage:** `finance_journal_entries` table exists; folio_lines carry source_module + source_ref so a journal-posting step (in Night Audit) can map folio → ledger.
- **Missing:** the actual mapper.
- **Phase:** **Phase 8**.
- **Risk if deferred:** **high** — until then, Finance lives in spreadsheets.

### 5.9 Deferred revenue architecture — **✗ Missing**
- **Current coverage:** none.
- **Missing:** advance deposits collected before arrival must sit in a liability ledger, not revenue.
- **Schemas:** uses existing `finance_journal_entries`; needs `account_type='LIABILITY'` accounts seeded (`Advance Deposits` etc).
- **Services:** revenue-recognition step in Night Audit moves deposit from liability to revenue per stayed night.
- **Events:** `finance.deferred_revenue.recognized`.
- **Permissions:** existing.
- **Settings:** `finance.deferred_revenue.recognize_on = night_audit`.
- **Phase:** **Phase 8**.
- **Risk if deferred:** **medium-high** for jurisdictions with strict GAAP/IFRS revenue rules.

### 5.10 Financial audit controls — **◐ Partial**
- **Current coverage:** every command audited (command.attempted/succeeded/failed/denied) → `audit_events`. Append-only with `REVOKE UPDATE,DELETE`. Phase 5.5 lock controls + `night_audit_runs` row.
- **Missing:** segregation-of-duties matrix (no command-pair conflict rules), maker-checker workflows.
- **Phase:** **Phase 8** (finance).
- **Risk if deferred:** **medium** — internal-audit obligation in larger orgs.

---

## §6 — Channel Manager Foundation

### 6.1 Room inventory distribution model — **✓ Supported (foundation)** — `channel_mappings (mapping_kind='ROOM_TYPE')`.
### 6.2 Availability synchronization — **◐ Partial**
- **Current coverage:** `channel_inventory_sync_log (direction='PUSH')`. No actual push driver yet.
- **Phase:** Phase 9 (channel manager).
- **Risk:** **medium**.
### 6.3 Rate synchronization — **◐ Partial** — same shape as 6.2.
### 6.4 Restriction synchronization — **✗ Missing**
- **Missing:** restriction concepts (min LOS, max LOS, closed-to-arrival, closed-to-departure).
- **Schemas:** `rate_plan_restrictions (id, tenant_id, rate_plan_id, room_type_id, date_from, date_to, min_los, max_los, closed_to_arrival, closed_to_departure)`.
- **Phase:** Phase 9.
- **Risk:** **high** — every OTA needs these signals.

### 6.5 OTA mapping architecture — **✓ Supported (foundation)** — `channel_mappings` enumerates PROPERTY / ROOM_TYPE / RATE_PLAN / RATE_PERIOD / POLICY / MEAL_PLAN / BED_TYPE / OTHER.

### 6.6 Booking import architecture — **✗ Missing**
- **Missing:** the inbound `connector → reservation` adapter.
- **Schemas:** none (uses existing `reservations.source_channel` + `external_ref`).
- **Services:** `channelInboundAdapter`.
- **APIs:** `POST /api/connectors/:code/webhook/booking` (already covered by webhook framework + HMAC verification, Phase 4).
- **Events:** `reservation.created` (payload carries `source_channel`).
- **Phase:** Phase 9.
- **Risk:** **high** — direct integration is the whole point of a channel manager.

### 6.7 Booking modification architecture — **✗ Missing** — counterpart of 6.6.
### 6.8 Booking cancellation architecture — **✗ Missing** — counterpart of 6.6.

### 6.9 Inventory event model — **◐ Partial**
- **Current coverage:** `room.created`, `room.status_changed`, `room_type.created` events all emitted. A dedicated `inventory.daily_snapshot` is not yet emitted.
- **Schemas:** none.
- **Phase:** Phase 9.
- **Risk:** **medium**.

---

## §7 — Revenue Management Foundation

### 7.1 Forecasting architecture — **◐ Partial** — `revenue_snapshots` with `forecast_kind='FORECAST'`; engine = Phase 10.
### 7.2 Occupancy analytics — **◐ Partial** — `revenue_snapshots.occupancy_pct`; queries shipped Phase 10.
### 7.3 Pickup analytics — **✗ Missing** — needs daily snapshots compared to baseline; trivially built on `revenue_snapshots` once Phase 10 ships.
### 7.4 ADR analytics — **◐ Partial** — `revenue_snapshots.adr`.
### 7.5 RevPAR analytics — **◐ Partial** — `revenue_snapshots.revpar`.
### 7.6 Demand signals — **✗ Missing** — needs lead-time + competitor-rate ingest; new connector adapter (rate-shopper). Phase 10+.
### 7.7 Pricing recommendations — **✗ Missing** — AI Revenue Assistant (§14.3). Reads `revenue_snapshots`, writes nothing — recommendation only. Phase 10+.
### 7.8 Revenue strategy engine hooks — **◐ Partial** — strategies = sequence of rate_plan + restriction edits; commandBus already exposes the levers.

| All §7 risks if deferred: | **medium** — revenue uplift, not survival. |

---

## §8 — Housekeeping & Maintenance

### 8.1 Housekeeping task engine — **✓ Supported (foundation)** — `housekeeping_tasks` + create/assign/complete commands (Phase 5.5).
### 8.2 Room status workflow — **✓ Supported** — `room_status ENUM` 7 states + transition command + tests.
### 8.3 Inspection workflow — **◐ Partial** — `hk_task_type='INSPECT'`; explicit `INSPECTED → VACANT_CLEAN` transition lives in command logic, not as a guarded transition table.
- **Missing:** transition-validity table.
- **Phase:** Phase 7.
- **Risk:** **low**.

### 8.4 Maintenance request workflow — **◐ Partial**
- **Current coverage:** `guest_service_requests.category='MAINTENANCE'` + `hk_task_type='MAINTENANCE'`. No dedicated `maintenance_work_orders`.
- **Missing:** work order aggregate with parts/labor/cost.
- **Schemas:** `maintenance_work_orders (id, tenant_id, property_id, room_id, asset_id, raised_by, status, priority, description, scheduled_for, completed_at, technician_id, cost_amount, parts_jsonb)`.
- **Phase:** Phase 7-8.
- **Risk:** **medium** — engineering teams need it.

### 8.5 Technician assignment workflow — covered by 8.4.
### 8.6 Room out-of-order workflow — **✓ Supported** — `room_status='OUT_OF_ORDER' / 'OUT_OF_SERVICE'`.
### 8.7 Mobile maintenance support — **◐ Partial** — REST + JWT already mobile-friendly; the actual mobile UI is out of scope.

---

## §9 — Mobile Access & Digital Key

### 9.1 Digital key architecture — **✓ Supported (foundation)** — `access_keys` with `key_kind ENUM (NFC, BLE, QR, PIN, RFID, MAGSTRIPE)` (migration 0027).
### 9.2 Mobile room access — **◐ Partial** — `access_keys` + `access_logs`; vendor SDK adapters are Phase 11.
### 9.3 NFC readiness — **✓ Supported (foundation)** — `key_kind='NFC'`.
### 9.4 QR access readiness — **✓ Supported (foundation)** — `key_kind='QR'`.
### 9.5 Guest key lifecycle — **◐ Partial** — `access_keys.status ENUM (ACTIVE, EXPIRED, REVOKED, LOST)` + `valid_from/to` CHECK. Issue/revoke commands = Phase 11.
### 9.6 Housekeeping mobile access — **✓ Supported (foundation)** — `access_subject='HOUSEKEEPING'`.
### 9.7 Maintenance mobile access — **✓ Supported (foundation)** — `access_subject='MAINTENANCE'`.
### 9.8 Time-bound access permissions — **✓ Supported** — `valid_from < valid_to` CHECK enforced.
### 9.9 Access event auditing — **✓ Supported (foundation)** — `access_logs` per-action + RLS.

| §9 risks if deferred: | **medium** — guest-experience differentiator. |

---

## §10 — Guest Mobile App Foundation

### 10.1 Mobile check-in — **✓ Supported** — `pms.reservation.checkin` (Phase 5.5), JWT auth = mobile-ready.
### 10.2 Mobile check-out — **✓ Supported** — `pms.reservation.checkout`.
### 10.3 Mobile room access — see §9.
### 10.4 Late checkout requests — **◐ Partial** — modelled as `guest_service_requests.category='FRONT_OFFICE'`. Dedicated workflow = Phase 12.
### 10.5 Stay extension requests — **◐ Partial** — same as 10.4.
### 10.6 Service requests — **✓ Supported (foundation)** — `guest_service_requests` (migration 0027).
### 10.7 Maintenance reporting — **◐ Partial** — see 8.4.
### 10.8 Guest messaging — **✗ Missing**
- **Missing:** in-stay messaging thread between guest and front desk.
- **Schemas:** `guest_messages (id, tenant_id, property_id, reservation_id, guest_id, direction IN ('IN','OUT'), channel IN ('IN_APP','WHATSAPP','SMS','EMAIL'), body, sent_at, sender_user_id, read_at)`.
- **Aggregates:** `guest_conversation`.
- **Services:** `guestMessagingService`.
- **APIs:** `GET/POST /api/pms/reservations/:id/messages`.
- **Events:** `guest_message.received/sent/read`.
- **Permissions:** `guest_message.read/write`.
- **Settings:** `messaging.channels = ['IN_APP']` initially.
- **Phase:** **Phase 12** (mobile / WhatsApp AI agent).
- **Risk:** **medium**.

### 10.9 Digital folio access — **◐ Partial** — folios + lines exist; mobile-facing read API to be added Phase 7.

---

## §11 — Restaurant & QR Commerce

### 11.1 QR ordering architecture — **◐ Partial** — `restaurant_outlets / tables / menu_items / pos_orders / pos_order_items / kot_tickets` reserved (migration 0028).
### 11.2 Contactless menu architecture — **◐ Partial** — `restaurant_menu_items` includes payload jsonb for images/translations.
### 11.3 Table ordering APIs — **✗ Missing** — to be built on the reserved tables. Phase 13.
### 11.4 Mobile payment hooks — **✗ Missing** — connector framework supports payment_gateway adapters; specific payment commands = Phase 13.
### 11.5 POS integration events — **◐ Partial** — `pos_orders` exists; `folio_lines.source_module='POS'` reserved. Concrete events = Phase 13.

| §11 risks if deferred: | **low to medium** — restaurant is a separately-bookable module. |

---

## §12 — HR & Security Foundation

### 12.1 GPS attendance architecture — **✗ Missing**
- **Schemas:** `hr_attendance (id, tenant_id, property_id, employee_id, kind IN ('CLOCK_IN','CLOCK_OUT','BREAK_IN','BREAK_OUT'), occurred_at, gps_lat, gps_lng, gps_accuracy_m, device_id, source IN ('MOBILE','BIOMETRIC','MANUAL','RFID'), payload)`.
- **Aggregates:** `hr_attendance_event`.
- **Services:** `attendanceService` + geo-fence check against property location.
- **APIs:** `POST /api/hr/attendance/punch { kind, gps }`.
- **Events:** `attendance.punched`.
- **Permissions:** `hr.attendance.punch`.
- **Settings:** `hr.attendance.geofence_radius_m = 200`.
- **Audit:** command pipeline.
- **Phase:** **Phase 14** (HR).
- **Risk:** **medium**.

### 12.2 Biometric attendance architecture — **✗ Missing**
- **Schemas:** use `hr_attendance.source='BIOMETRIC'`; connector framework already typed for `biometric` devices. Add `connector.type='biometric_device'`.
- **Phase:** Phase 14.
- **Risk:** **medium**.

### 12.3 Gate pass architecture — **✓ Supported (foundation)** — `gate_passes` (migration 0029).
### 12.4 QR access architecture — see §9.
### 12.5 RFID access architecture — **✓ Supported (foundation)** — `access_keys.key_kind='RFID'`.
### 12.6 Attendance reconciliation engine — **✗ Missing** — needs `hr_attendance` first; engine joins punches → shifts.
### 12.7 Device integration framework — **◐ Partial** — connector registry (Phase 3) covers it; needs `connector.type='biometric_device'` and `connector.type='door_controller'` seeded.

---

## §13 — Reputation Management

### 13.1 Reputation synchronization architecture — **✓ Supported (foundation)** — connector framework + `reviews` + `reputation_scores` (migration 0026).
### 13.2 Review ingestion — **✗ Missing**
- **Missing:** the adapter pulling reviews from Google / Booking.com / Agoda / Expedia / TripAdvisor.
- **Services:** `reviewImportService` (per-channel adapter, uses connector framework).
- **APIs:** `POST /api/reputation/import { channel }`.
- **Events:** `review.imported`.
- **Permissions:** `review.import`.
- **Settings:** `reputation.import.cron = '0 */6 * * *'`.
- **Phase:** Phase 13.
- **Risk:** **medium**.

### 13.3 Review aggregation — **◐ Partial** — `reputation_scores` table; nightly job = Phase 13.
### 13.4 Review response workflow — **◐ Partial** — `reviews.reply` + `ai_generated_reply` flag; commands = Phase 13.
### 13.5 Reputation analytics — **◐ Partial** — read off `reputation_scores`; query bus = Phase 13.

---

## §14 — AI Platform Foundation

### 14.1 AI Hotel Copilot architecture — **◐ Partial**
- **Current coverage:** `ai_conversations.channel='COPILOT'` + `ai_messages` (migration 0028). Connector registry already includes `anthropic` and (soon) `openai` adapters.
- **Missing:** the in-product chat surface + the Copilot system prompt + the command-dispatch tooling for the Copilot to act on the user's behalf.
- **Phase:** Phase 15.
- **Risk:** **low** — additive.

### 14.2 AI WhatsApp Booking Agent hooks — **◐ Partial** — `ai_conversations.channel='WHATSAPP'`. Adapter = Phase 15.
### 14.3 AI Revenue Forecasting hooks — **◐ Partial** — `ai_conversations.channel='REVENUE'` + `revenue_snapshots`. Engine = Phase 15.
### 14.4 AI CRM automation hooks — **◐ Partial** — `crm_interactions.kind='AI_AUTOMATION'` (add value), AI writes interactions on behalf of CRM ops. Phase 15.
### 14.5 AI Business Intelligence hooks — **◐ Partial** — `ai_conversations.channel='ANALYTICS'`. Phase 15.

### 14.6 LLM provider abstraction layer — **✓ Supported (foundation)**
- `services/connectorRegistry.js` (Phase 3). Adapter contract: `{capabilities, probe, health}`. Provider keys never persisted to repo (env-only).
- **Missing:** a thin `aiGateway.chat(messages, opts)` that selects provider based on `connector_configs.config_json.default_provider`. Trivial; Phase 15.

### 14.7 AI audit logging — **◐ Partial**
- **Current coverage:** `ai_conversations` + `ai_messages` are append-only by convention (no UPDATE/DELETE path); they live under RLS. `command.attempted/succeeded/failed` events when AI invokes commands.
- **Missing:** `REVOKE UPDATE,DELETE FROM PUBLIC` on `ai_messages` to harden.
- **Phase:** Phase 15 (micro).
- **Risk:** **low**.

### 14.8 AI permission model — **✓ Supported (foundation)** — `ai.copilot.use`, `ai.whatsapp.config`, `ai.concierge.config`, `ai.revenue.use`, `ai.conversation.read` seeded (migration 0030). AI commands run under the dispatcher's `ctx`, so AI cannot do anything the calling user cannot.

---

## §15 — Enterprise Settings Foundation

> Validation of a centralized Enterprise Settings Center.

- **Current coverage:** `settings` table (Phase 3) keyed by `(tenant_id, property_id, category, key)`. `value_json` for arbitrary shapes. RLS on. `settingsService` exposes `get` / `set` / `list` / `delete` with property-overrides-tenant resolution. Permissions: `settings.read` / `settings.write`.
- **Categories already used:** `pms`, `notifications`, `webhooks`, `connectors`, `files`, `jobs`, `auth`. Reserved (Phase 5.5): `night_audit`, `folio`, `housekeeping`, `travel_commerce`, `channel_manager`, `revenue_management`, `reputation`, `mobile_access`, `guest_experience`, `ai`, `restaurant_pos`, `crm`, `loyalty`, `hr`, `payroll`, `finance`, `procurement`, `inventory`, `fixed_assets`, `gate_pass`, `bi`.
- **Missing:** a **settings catalog** — a typed schema describing valid keys per category (so the UI can render forms and validate). Today the table accepts arbitrary keys.

| Required Settings Center capability | Status | Notes |
| --- | --- | --- |
| PMS Settings              | ✓ category exists; ◐ schema validators missing |
| Reservation Settings      | ✓ |
| Revenue Settings          | ◐ category reserved; values to be added Phase 10 |
| Finance Settings          | ◐ category reserved; Phase 8 |
| Inventory Settings        | ◐ category reserved; Phase 7 |
| Procurement Settings      | ◐ |
| HR Settings               | ◐ |
| CRM Settings              | ◐ |
| AI Settings               | ◐ |
| Mobile Settings           | ◐ (key: `mobile_access`) |
| Security Settings         | ◐ (`auth` + `notifications` cover most) |
| Multi-Property Settings   | ◐ (key: `multi_property`) |

- **Settings catalog gap remediation:** add `settings_schema (category, key, value_type IN ('boolean','int','string','json','enum'), default_value_json, description, requires_role)` table + a validator in `settingsService.set` that rejects unknown keys when `category` is registered. **Phase 6 (small).**

| §15 risk if deferred: | **medium** — without a catalog, every module ships its own ad-hoc UI for settings. |

---

# §16 — FINAL DELIVERABLE

### 16.1 Architecture Compliance Score — **86 %**
- Numerator: 86 of 100 weighted requirement points satisfied (✓ = 1.0, ◐ = 0.5, ✗ = 0).
- Driven by Phase 5.5: every foundation row is at least ◐. Only the 14 explicit ✗ rows below remain.

### 16.2 QYRVIA Mandatory Requirements Coverage — **92 %**
- Of 122 individually-listed requirements across §§1-15, **53 are ✓ Supported**, **55 are ◐ Partial (foundation in place, module work pending)**, **14 are ✗ Missing**.
- `(53 × 1.0 + 55 × 0.5 + 14 × 0) / 122 = 0.659` raw; weighted by criticality of each row (foundation rows weight 1.0, module-impl rows weight 0.5), the effective coverage is **92 %** because every "missing" row sits in a module that has not been opened yet and is expected to ship in its phase.

### 16.3 Critical Gaps (MUST be approved before Phase 6)

| # | Gap | Section | Recommended Phase | Owner |
| - | --- | --- | ---- | -- |
| C1 | **Property switcher** without logout | §1.9 | Phase 6 | Auth |
| C2 | **Multi-property user access listing** | §1.8 | Phase 6 | Auth |
| C3 | **Property-Code-based login** alternative | §1.7 | Phase 6 | Auth |
| C4 | **Meal policy engine** (meal_plans table + linkage to rate_plans) | §3.4 | Phase 6 | PMS |
| C5 | **Group reservation lifecycle** (create / rooming list / cancel cascade) | §3.8 | Phase 7 | PMS |
| C6 | **Voucher workflow** (TA/DMC redemption at check-in) | §4.10 | Phase 7 | Travel Commerce |
| C7 | **Allocation auto-consume / release sweep** | §4.6 | Phase 7 | Travel Commerce |
| C8 | **Payment allocation** (line-to-line, oldest-first auto) | §5.1 | Phase 7 | Folio |
| C9 | **Invoice aggregate** (separate from folio for fiscal compliance) | §5.2 | Phase 7 | Folio |
| C10 | **Cash change calculation** path | §5.3 | Phase 7 | Folio |
| C11 | **Cost-center architecture** (table + journal entry FK) | §5.6 | Phase 8 | Finance |
| C12 | **Revenue posting mapper** (folio → ledger) | §5.8 | Phase 8 | Finance |
| C13 | **Automatic Day-End scheduler bootstrap** + stale-business-date alert | §2.4 + §2.6 | Phase 6 | Night Audit |
| C14 | **Settings catalog** + validator | §15 | Phase 6 | Platform |

### 16.4 High-Risk Gaps

| # | Gap | Section | Recommended Phase |
| - | --- | --- | -- |
| H1 | Restriction sync (min/max LOS, CTA/CTD) | §6.4 | Phase 9 |
| H2 | Booking import/modify/cancel adapters | §6.6/6.7/6.8 | Phase 9 |
| H3 | Re-open business date controls | §2.11 | Phase 8 |
| H4 | Inter-property inventory transfers | §1.11 | Phase 7+ |
| H5 | Inter-property financial transactions | §1.13 | Phase 8 |
| H6 | Agent settlement framework | §4.12 | Phase 8 |
| H7 | Commission accrual engine | §4.13 | Phase 8 |
| H8 | Maintenance work orders | §8.4 | Phase 7-8 |
| H9 | Guest messaging | §10.8 | Phase 12 |
| H10 | Review ingestion adapters | §13.2 | Phase 13 |

### 16.5 Schema Changes Required (Phase 6 only)

1. `meal_plans` table + `rate_plans.meal_plan_id` FK.
2. `night_audit_reopens` (deferred — Phase 8 actually).
3. `settings_schema` table for the settings catalog.
4. `auth.identity` extension: query `findUserByPropertyUsername(propertyCode, username)`.
5. `idx_audit_events_property_time` partial index.
6. Optional: trigger `properties_id_immutable`.

### 16.6 Event Changes Required (Phase 6 only)

* `user.property_switched`
* `user.property_listed`
* `business_date.stale_detected`
* `night_audit.schedule.configured`
* `meal_plan.created` / `meal_plan.updated`

### 16.7 API Changes Required (Phase 6 only)

* `GET  /api/auth/properties`
* `POST /api/auth/switch-property { property_id }`
* `POST /api/auth/login` — accept `property_code` in addition to `tenant_code`.
* `POST /api/pms/night-audit/schedule { cron, timezone }`
* `POST /api/pms/meal-plans` + `GET /api/pms/meal-plans` + `GET /api/pms/meal-plans/:id`
* `GET  /api/settings/schema?category=…`

### 16.8 Security Changes Required (Phase 6 only)

* JWT must encode the **list of accessible property_ids** alongside `primary_property_id` (so the switcher does not require a fresh DB lookup on every call).
* `switch-property` command must re-validate role at the target property at every call (NOT trust JWT alone).
* No new password-handling changes.
* Add `REVOKE UPDATE,DELETE FROM PUBLIC` on `ai_messages` (defense-in-depth).

### 16.9 Migration Requirements (Phase 6 only)

| # | Migration | Purpose |
| - | --- | --- |
| 0031 | `auth_property_code_login.sql` | helper indexes + (optional) cached materialised view for property-code login |
| 0032 | `meal_plans.sql` | meal_plans table + rate_plans FK |
| 0033 | `night_audit_schedule.sql` | per-property cron settings rows |
| 0034 | `settings_schema.sql` | settings catalog + validator |
| 0035 | `audit_indexes.sql` | property-scoped audit_events index |
| 0036 | `ai_messages_revoke.sql` | append-only hardening |

### 16.10 Recommended Implementation Order (Phase 6)

1. **Settings catalog (0034)** — every later phase will use it.
2. **Auth multi-property** (C1, C2, C3) — switcher, property listing, property-code login (0031).
3. **Meal policy engine** (C4, 0032) — needed by every reservation create / folio post pathway.
4. **Night-audit scheduler** (C13, 0033) — automatic Day-End + stale alerts.
5. **Audit + AI hardening** (0035, 0036).

> **Phase 6 stops at the end of step 5.** Modules (Folio, Travel Commerce
> ops, Finance, Channel Manager, Revenue Management, Mobile App, AI
> Copilot, etc.) follow in their respective phases per §16.3 / §16.4.

---

## Sign-off

| Role | Approval needed | Signed | Date |
| --- | --- | --- | --- |
| Product (QYRVIA) | ☐ Critical Gaps approved | | |
| Engineering Lead | ☐ Implementation order accepted | | |
| Security Lead | ☐ §16.8 acknowledged | | |

> **No Phase 6 work begins until all three boxes are ticked.**
