# QYRVIA Phase 7 — Completion Report

> Phase 7 closes the six Folio + Travel-Commerce Critical Gaps that
> followed Phase 6: **C8, C10, C9, C7, C6, C5**.

## Headline Numbers

| Metric | Pre-Phase-7 | Post-Phase-7 |
| ------ | ----------- | ------------ |
| Backend tests passing | 290 / 290 | **333 / 333** |
| Migrations            | 0001..0036 | **0001..0041** |
| Critical Gaps in Phase 7 scope | 6 | **0** |
| Remaining Critical Gaps overall | 8 | **2** (C11, C12 → Phase 8 Finance) |
| Frontend HTML monolith hash | `5de5b155a0280acbe6a2e834a0ea015b` | **`5de5b155a0280acbe6a2e834a0ea015b`** (byte-identical) |

## Critical Gaps Closed

| # | Gap | Resolution |
| - | --- | ---------- |
| **C8** | Payment allocation | `payment_allocations` table (migration 0037). `paymentAllocationService.allocate` with explicit map OR auto-distribute oldest-first. Command `pms.folio.payment.allocate` (accountingSensitive). Cross-folio + over-allocation refused. Query `pms.folio.allocations.list`. Routes `POST /folios/:id/payments/:pid/allocate` + `GET /folios/:id/allocations`. New permission `folio.allocate.read`. |
| **C10** | Cash change calculation | Command `pms.folio.payment.cash` (accountingSensitive). Computes `change = tendered - amount`, posts a PAYMENT folio_line with metadata `{method:'CASH', tendered, change}`. Rejects `tender_insufficient` when tendered < due. Settings catalog: `payment.cash.rounding_unit`. Route `POST /folios/:id/payments/cash`. |
| **C9** | Invoice aggregate | Migration 0038: `invoices` + `invoice_counters` tables, `invoice_status` enum. Commands `pms.invoice.issue_from_folio` + `pms.invoice.void` (both accountingSensitive). Queries `pms.invoice.list / .byId / .byNumber`. Issuance refused while `folio.balance != 0`. Void requires `reason`. Numbering format from settings catalog: `invoice.numbering.format` (default `{PROPCODE}-INV-{YYYY}-{NNNNNN}`). New permissions: `invoice.read / .write / .void`. |
| **C7** | Allocation auto-consume + release sweep | Migration 0039: indexes + permission `allocation.release`. `allocationService` with `consume`, `decrement`, `release`, `sweepReleases`. Commands `pms.allocation.create`, `.release`, `.release_sweep`. Subscribers wired in `src/index.js` on `reservation.created` (auto-consume) + `reservation.cancelled` (auto-release-back). Scheduler handler for the recurring sweep job. New event types: `allocation.created`, `allocation.consumed`, `allocation.released_back`, `allocation.exhausted`, `allocation.released`, `allocation.sweep_completed`. Catalog: `allocations.default_release_days`. |
| **C6** | Voucher workflow | Migration 0040: `vouchers` table + `voucher_status` enum + 3 permissions. Commands `pms.voucher.issue`, `pms.voucher.redeem` (accountingSensitive), `pms.voucher.cancel`. Double-redeem refused; cancelled/expired vouchers refused. Query `pms.voucher.byNumber`. Routes `POST /vouchers`, `POST /vouchers/:n/redeem`, `POST /vouchers/:n/cancel`, `GET /vouchers/:n`. Settings catalog: `vouchers.default_validity_days`. |
| **C5** | Group reservation lifecycle | Migration 0041: helper index. Commands `pms.reservation_group.create`, `.add_room`, `.cancel_all`, `.checkin_all`. Cross-property add refused. Cancel-all refuses to cascade if any member is CHECKED_IN unless `force=true`. Member-level cancellations dispatch real `pms.reservation.cancel` commands (full audit chain). Settings catalog: `pms.groups.auto_block_inventory`, `pms.groups.cancel_requires_force_when_checked_in`. Queries `pms.reservation_group.byId / .rooming_list`. Routes under `/reservation-groups`. |

## Files Created

| Migration | Purpose |
| --------- | ------- |
| `0037_pms_payment_allocations.sql` | C8 — payment_allocations table + permission |
| `0038_pms_invoices.sql`             | C9 — invoices + invoice_counters + status enum + 3 permissions |
| `0039_pms_allocation_lifecycle.sql` | C7 — indexes + allocation.release permission |
| `0040_pms_vouchers.sql`             | C6 — vouchers table + status enum + 3 permissions |
| `0041_pms_group_lifecycle.sql`      | C5 — rooming-list index |

| Code | Purpose |
| ---- | ------- |
| `services/pms/paymentAllocation.js` | Auto-distribute + explicit allocation engine |
| `services/pms/allocation.js`        | Consume / decrement / release / sweepReleases |
| `commands/pms/paymentAllocation.js` | `pms.folio.payment.allocate` |
| `commands/pms/invoices.js`          | `pms.invoice.issue_from_folio`, `pms.invoice.void`; number template helper |
| `commands/pms/allocations.js`       | `pms.allocation.create / .release / .release_sweep` |
| `commands/pms/vouchers.js`          | `pms.voucher.issue / .redeem / .cancel` |
| `commands/pms/reservationGroups.js` | Group create / add-room / cancel-all / checkin-all |

| Tests (new) | # |
| --------- | - |
| `folio_payment_allocations.test.js` | 7 |
| `folio_cash_payment.test.js`        | 5 |
| `pms_invoices.test.js`              | 6 |
| `pms_allocations.test.js`           | 6 |
| `pms_vouchers.test.js`              | 7 |
| `pms_reservation_groups.test.js`    | 6 |
| `architectureReadiness.test.js` (+6) | 6 |

## Files Modified

| File | Change |
| ---- | ------ |
| `db/repos.js` | New repo methods for payment_allocations, invoices, allocations lifecycle, vouchers, reservation groups |
| `commands/pms/index.js` | Reservation create now carries `allocation_id`, `contract_id`, `group_id` into both the row and event payload; cancellation event carries them too |
| `commands/pms/checkinFolio.js` | New `pms.folio.payment.cash` command |
| `queries/pms/index.js` | New queries: `pms.folio.allocations.list`, `pms.invoice.list/.byId/.byNumber`, `pms.voucher.byNumber`, `pms.reservation_group.byId/.rooming_list`. `makeQueries({pmsRepo, folioRepo})`. |
| `services/settingsCatalogBoot.js` | New catalog entries: `payment.cash.rounding_unit`, `invoice.numbering.format`, `invoice.allow_void_after_days`, `allocations.default_release_days`, `vouchers.default_validity_days`, `pms.groups.auto_block_inventory`, `pms.groups.cancel_requires_force_when_checked_in` |
| `routes/pms.js` | New routes under `/folios/:id/payments/*`, `/invoices/*`, `/vouchers/*`, `/reservation-groups/*` |
| `index.js` | Boot wiring: Payment Allocation, Invoices, Vouchers, Allocation lifecycle (with subscribers + sweep scheduler handler), Reservation Groups |
| `test/_fixtures.js` | In-memory mirrors for allocations, vouchers, invoices, reservation groups, folio allocations |
| `test/architectureReadiness.test.js` | Verifies 0037-0041 contiguous, key tables / enums / permissions present |

## Binding Constraints Honoured

All 10 Phase 6 conditions remain in force in Phase 7:

1. **No architectural regressions.** All 290 pre-Phase-7 tests pass unchanged; 333/333 total green.
2. **Backward compatibility.** Every new endpoint is additive. Reservation creation still works without `allocation_id` / `contract_id` / `group_id`. Folio commands unchanged. Login + auth unchanged.
3. **Property ID immutable + primary identifier.** Every new command requires `ctx.propertyId` where the aggregate is property-scoped (invoices, vouchers, allocations, reservation groups). Cross-property pairings explicitly rejected (folio↔invoice, voucher↔reservation, group↔room).
4. **Property-ID + audit + business-date awareness.** Every new write emits a `<aggregate>.<verb_past>` event through commandBus → audit pipeline → eventBus (audit_events + event_store). Payment allocation, cash payment, invoice issue/void, voucher redemption, allocation consume all stamp `business_date`.
5. **Enterprise Settings Center sole source.** Every new tunable lives in `settingsCatalogBoot.js`. No code path reads from env or hard-codes a value behind a magic constant.
6. **Night Audit architecture preserved.** All new accounting-sensitive commands declare `accountingSensitive: true`; verified by `accountingSensitive.test.js` (Phase 5.5) which still passes.
7. **TA/DMC/Contracting/Allocation/Proforma first-class.** Allocations now consume + release automatically; vouchers cover TA/DMC redemption; contracts FK from reservations + allocations + vouchers preserved.
8. **Channel/RM/Reputation/Mobile/Digital Key/QR/WhatsApp foundations preserved.** Phase 5.5 schemas + permissions intact; Phase 7 only added rows.
9. **CQRS/EDA/RBAC/audit/tenant/property enforcement.** Every new command goes through commandBus; every new query through queryBus. All new routes wrap `requirePermission(...)`. RLS forced on every new table.
10. **No fake AI / no demo data.** Phase 7 didn't touch AI surfaces. No seed data introduced; in-memory test fixtures stand in for real persistence only inside tests.

## Compliance Score Update

| Metric | After Phase 6 | After Phase 7 |
|---|---|---|
| Critical gaps remaining | 8 (C5–C12) | **2 (C11, C12)** |
| Architecture Compliance Score | ~92 % | **~98 %** |
| Mandatory Requirement Coverage | ~92 % | **~96 %** |

The only Critical Gaps remaining are C11 (Cost-Center architecture) and C12 (Revenue posting mapper) — both Finance-module work, scheduled for Phase 8.

## Latent Bug Fixes

None this phase. All assertions in `architectureReadiness.test.js` extended for the six new migrations and verified before completion.

## Stop Notice

**Phase 7 is complete.** No further work in Phase 7 scope. Phase 8 (Finance) is scoped to:
- C11 — Cost-Center architecture (cost_centers table + journal_entry FK + UI hooks)
- C12 — Revenue posting mapper (folio → ledger; subscriber inside Night Audit)
- H3 — Re-open business date controls
- H5 — Inter-property financial transactions
- H6 — Agent settlement framework
- H7 — Commission accrual engine

Awaiting Phase 8 brief.
