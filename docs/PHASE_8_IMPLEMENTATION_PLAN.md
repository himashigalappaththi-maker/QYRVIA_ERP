# QYRVIA Phase 8 — Implementation Plan (Finance Core)

> Brief is prescriptive; this plan confirms execution shape and resolves
> two backward-compatibility judgement calls. **Hard rule (non-negotiable):**
> every financial mutation produces balanced ledger entries (debit==credit);
> missing revenue-posting map = HARD FAIL.
>
> All ten Phase 6 binding constraints remain in force.

---

## Migrations (3)

| File | Purpose |
|------|---------|
| `0042_finance_cost_centers.sql` | `cost_centers` table; nullable `cost_center_id` FK added to `invoices`, `folio_lines`, `vouchers`, `payment_allocations`; permissions `cost_center.read/write`. |
| `0043_finance_revenue_posting_map.sql` | `revenue_posting_map` table; permissions `revenue_map.read/write`. |
| `0044_finance_ledger.sql` | `ledger_entries` + `ledger_batches`; append-only (`REVOKE UPDATE,DELETE FROM PUBLIC`); permissions `ledger.read/write/revert`. |

All three are additive — no destructive changes to Phase 5/6/7 schema.

## Code

- **`db/repos.js`** — `costCenterRepo` (+CRUD), `revenueMapRepo` (upsert/find/list), `ledgerRepo` (insertEntry/insertBatch/findByReference/listByCostCenter/listByBatch).
- **`services/finance/ledgerService.js`** — `prepareForEvent`, `postEntries`, `validateBalance`, `revertBatch`, `getLedgerByReference`.
- **`commands/finance/`** — `costCenters.js`, `revenueMap.js`, `ledger.js`.
- **Integration:** extend three Phase 7 commands inline (NOT subscriber) so an imbalance can reject the command up-front:
  - `pms.invoice.issue_from_folio` — requires `cost_center_id`; calls `ledgerService.prepareForEvent('invoice.issued', amount)`; rejects with `mapping_missing` or `ledger_imbalance` BEFORE inserting the invoice; on success posts via `postEntries`.
  - `pms.folio.payment.allocate` — same pattern; event_type=`folio.payment_allocated`.
  - `pms.voucher.redeem` — same pattern; event_type=`voucher.redeemed`.

## Hard-fail flow

```
command -> ledgerService.prepareForEvent(eventType, amount, ctx)
  step 1: revenueMapRepo.findOne(tenant_id, property_id, event_type)
  step 2: if missing -> { ok:false, error:'mapping_missing' }
  step 3: build [{debit_account, amount, cost_center_id}, {credit_account, amount, cost_center_id}]
  step 4: validateBalance -> sum(debit) === sum(credit) else { ok:false, error:'ledger_imbalance' }
  step 5: return { ok:true, entries }
command checks ok; if !ok -> return error, emit ledger.imbalance_rejected
otherwise: insert primary record, then ledgerService.postEntries(entries, refType, refId, ctx)
  -> emits ledger.entry.created (per entry) + ledger.batch.posted
```

## Backward-compatibility judgment calls

1. **Cost center on `folio_lines.charge_type='PAYMENT'`** — not required (payments don't generate revenue; only allocation/invoice posts do). Folio charges (ROOM, FNB, etc.) take an OPTIONAL `cost_center_id` so existing tests keep passing; invoice issuance demands it explicitly.
2. **Phase 7 tests that issue invoices / redeem vouchers / allocate payments** — extended in Step 5 to call a new test helper `_seedFinanceDefaults(commandBus, ctx)` that creates a default cost center + the three required revenue-map rows. Existing assertions otherwise unchanged.

## Acceptance criteria mapping

| # | Brief criterion | How |
|---|---|---|
| 1 | All ledger entries balance | `ledgerService.validateBalance` runs in `prepareForEvent` + `postEntries`; emits `ledger.imbalance_rejected` on failure |
| 2 | No financial event bypasses mapper | Integration commands always call `prepareForEvent` first; tests cover `mapping_missing` rejection |
| 3 | Cost center is enforced | `invoice.issue_from_folio`, `voucher.redeem`, `folio.payment.allocate` reject if `cost_center_id` missing |
| 4 | Revenue mapping required (no fallback) | `prepareForEvent` returns `mapping_missing` if `findRevenueMap` returns null; no try/catch fallback anywhere |
| 5 | All Phase 7 flows produce ledger output | Verified by 3 new integration test files |
| 6 | No cross-property financial leakage | RLS on ledger tables; `findRevenueMap` keyed by `(tenant_id, property_id, event_type)`; cost center → property FK; cross-property cost_center refused at command level |
| 7 | 100% tests pass | Target ≥ 360 tests; verified at end |

## Test plan

| File | Tests | Covers |
|------|-------|--------|
| `finance_cost_centers.test.js` | 5 | CRUD + cross-property refusal + disable |
| `finance_revenue_map.test.js` | 4 | Upsert + UNIQUE constraint + delete + property scope |
| `finance_ledger.test.js` | 6 | postEntries balanced/imbalanced; revertBatch; getLedgerByReference; cross-property isolation |
| `finance_invoice_ledger.test.js` | 4 | Invoice issue posts AR/Revenue entries; mapping_missing rejects |
| `finance_payment_ledger.test.js` | 3 | Allocation posts Cash/AR entries |
| `finance_voucher_ledger.test.js` | 3 | Redeem posts Discount/Revenue entries |
| Existing Phase 7 tests | n/a | Updated to seed defaults via helper |

Target final count: **≥ 360 / 360 backend tests passing.**

## Out of scope for Phase 8

H3 (re-open business date controls), H5 (inter-property finance), H6 (agent settlement), H7 (commission accrual) — left for Phase 9 / 10 unless the next gate brief pulls them in.
