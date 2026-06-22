# QYRVIA Phase 7 — Implementation Plan

> Approved scope: close Critical Gaps **C8, C10, C9, C7, C6, C5** in that
> dependency order. Six steps, ~18.5 focused days, five additive
> migrations (`0037`–`0041`), no destructive changes.
>
> All binding constraints from Phase 6 approval letter remain in force
> (no regressions, BC, immutable Property ID, audit + business-date
> awareness, Settings Center sole source, CQRS+EDA+RBAC, no fake AI).
>
> **Step boundary:** when step N finishes, **all 290+ existing tests still
> pass** AND the step's own new tests pass before step N+1 begins.

---

## Step 1 — Payment Allocation (C8)

### Deliverables
- Migration `0037_pms_payment_allocations.sql`.
- `folioRepo.insertPaymentAllocation / listAllocationsForPayment / listAllocationsForCharge`.
- `paymentAllocationService.allocate(folioId, paymentLineId, allocations)` + auto-distribute helper.
- Commands: `pms.folio.payment.allocate` (accountingSensitive).
- Queries: `pms.folio.allocations.byPayment`, `pms.folio.allocations.byCharge`.
- Routes: `POST /api/pms/folios/:id/payments/:pid/allocate`, `GET /api/pms/folios/:id/allocations`.

### Schemas
```sql
CREATE TABLE payment_allocations (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID         NOT NULL REFERENCES tenants(id),
  folio_id          UUID         NOT NULL REFERENCES folios(id) ON DELETE CASCADE,
  payment_line_id   UUID         NOT NULL REFERENCES folio_lines(id) ON DELETE CASCADE,
  charge_line_id    UUID         NOT NULL REFERENCES folio_lines(id) ON DELETE CASCADE,
  amount_allocated  NUMERIC(14,2) NOT NULL CHECK (amount_allocated > 0),
  allocated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  allocated_by      UUID,
  business_date     DATE
);
CREATE INDEX idx_pa_payment ON payment_allocations(payment_line_id);
CREATE INDEX idx_pa_charge  ON payment_allocations(charge_line_id);
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations FORCE  ROW LEVEL SECURITY;
CREATE POLICY pa_by_app ON payment_allocations
  USING (tenant_id::text = current_setting('app.tenant_id', true));
```

### Aggregates
- `payment_allocation` (sub-resource of folio).

### Events
- `folio.payment_allocated` — payload `{folio_id, payment_line_id, total_amount, allocation_count}`.

### APIs
- `POST /api/pms/folios/:id/payments/:pid/allocate` — body `{allocations: [{charge_line_id, amount}]}` OR omitted (auto oldest-first).
- `GET  /api/pms/folios/:id/allocations` — list all allocations for the folio.

### Permissions
- Re-uses existing `folio.post` for write; new `folio.allocate.read` for read view.

### Settings (already in catalog)
- `folio.payment.auto_allocate_oldest_first` (boolean, default true).

### Migration Impact
Additive only. New table; no FK on existing tables modified.

### Test Coverage Requirements
- Single payment auto-allocates oldest charge.
- Payment > sum-of-charges leaves remainder unallocated.
- Explicit allocation map honoured.
- Allocation across folios refused (FK check + service guard).
- Cross-tenant allocation refused.
- Allocation is `accountingSensitive` → blocked when `businessDateLocked=true`.

### Acceptance Criteria
- 290 existing tests still pass.
- New `test/folio_payment_allocations.test.js` ≥7 tests pass.
- `folio.payment_allocated` event present in audit_events + event_store.

---

## Step 2 — Cash Change Calculation (C10)

### Deliverables
- New command `pms.folio.payment.cash` (accountingSensitive) — extends `pms.folio.charge.post` for cash specifically; computes change, posts PAYMENT line with metadata `{method:'CASH', tendered, change}`.
- Route `POST /api/pms/folios/:id/payments/cash`.

### Schemas
None. Uses existing `folio_lines.metadata JSONB`.

### Aggregates
None new.

### Events
- `folio.payment_received` — payload `{folio_id, method:'CASH', tendered, change, business_date}`.

### APIs
- `POST /api/pms/folios/:id/payments/cash` body `{amount, tendered, description?}` returns `{line_id, change}`.

### Permissions
- `folio.post` (existing).

### Settings (catalog)
- `payment.cash.rounding_unit` (number, default 0.01) — NEW catalog entry.

### Migration Impact
None.

### Test Coverage Requirements
- Tendered > due → returns change.
- Tendered = due → change=0.
- Tendered < due → returns `tender_insufficient`.
- Stores `{method:'CASH', tendered, change}` in `folio_lines.metadata`.
- accountingSensitive guard active.

### Acceptance Criteria
- ≥5 new tests in `test/folio_cash_payment.test.js`.

---

## Step 3 — Invoice Aggregate (C9)

### Deliverables
- Migration `0038_pms_invoices.sql` (table + counter).
- Repo `folioRepo` extended with `bumpInvoiceCounter / insertInvoice / findInvoiceById / findInvoiceByNumber / listInvoices / voidInvoice`.
- Commands `pms.invoice.issue_from_folio` (accountingSensitive), `pms.invoice.void` (accountingSensitive).
- Queries `pms.invoice.list / .byId / .byNumber`.
- Routes under `/api/pms/invoices`.

### Schemas
```sql
CREATE TYPE invoice_status AS ENUM ('DRAFT','ISSUED','PAID','VOIDED','REPLACED');

CREATE TABLE invoices (
  id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID            NOT NULL REFERENCES tenants(id),
  property_id       UUID            NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  folio_id          UUID            NOT NULL REFERENCES folios(id) ON DELETE RESTRICT,
  invoice_number    VARCHAR(40)     NOT NULL,
  status            invoice_status  NOT NULL DEFAULT 'ISSUED',
  currency          CHAR(3)         NOT NULL DEFAULT 'LKR',
  issued_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),
  paid_at           TIMESTAMPTZ,
  voided_at         TIMESTAMPTZ,
  void_reason       TEXT,
  total_amount      NUMERIC(14,2)   NOT NULL DEFAULT 0,
  tax_amount        NUMERIC(14,2)   NOT NULL DEFAULT 0,
  balance           NUMERIC(14,2)   NOT NULL DEFAULT 0,
  bill_to_guest_id  UUID            REFERENCES guests(id),
  business_date     DATE,
  payload           JSONB           NOT NULL DEFAULT '{}'::jsonb,
  created_by        UUID,
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_invoices_number ON invoices(property_id, invoice_number);
CREATE INDEX idx_invoices_folio ON invoices(folio_id);
CREATE INDEX idx_invoices_tenant_status ON invoices(tenant_id, status);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE  ROW LEVEL SECURITY;
CREATE POLICY invoices_by_app ON invoices
  USING (tenant_id::text = current_setting('app.tenant_id', true));

CREATE TABLE invoice_counters (
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  property_id  UUID         NOT NULL REFERENCES properties(id),
  year         INTEGER      NOT NULL,
  next_number  INTEGER      NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, year)
);
ALTER TABLE invoice_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_counters FORCE  ROW LEVEL SECURITY;
CREATE POLICY ic_by_app ON invoice_counters
  USING (tenant_id::text = current_setting('app.tenant_id', true));

INSERT INTO permissions (code, description) VALUES
  ('invoice.read',  'Read invoices'),
  ('invoice.write', 'Issue an invoice from a folio'),
  ('invoice.void',  'Void an invoice')
ON CONFLICT (code) DO NOTHING;
```

### Aggregates
- `invoice` (DRAFT → ISSUED → PAID | VOIDED | REPLACED).

### Events
- `invoice.issued`, `invoice.paid`, `invoice.voided`.

### APIs
- `POST /api/pms/invoices/issue { folio_id }` (alias for `pms.invoice.issue_from_folio`).
- `POST /api/pms/invoices/:id/void { reason }`.
- `GET  /api/pms/invoices`, `/:id`, `/number/:n`.

### Permissions
- `invoice.read`, `invoice.write`, `invoice.void` — granted to corporate_admin + property_admin + front_office_manager.

### Settings (catalog)
- `invoice.numbering.format` (string, default `'{PROPCODE}-INV-{YYYY}-{NNNNNN}'`).
- `invoice.allow_void_after_days` (int, default 7).

### Migration Impact
Additive only.

### Test Coverage Requirements
- Issue from SETTLED folio → INVOICE row created with format `PROPCODE-INV-YYYY-000001`.
- Issue from folio with non-zero balance → fails `folio_has_balance`.
- Void requires reason; success transitions to VOIDED + emits event.
- Cross-tenant invoice query returns empty.
- accountingSensitive guard active.

### Acceptance Criteria
- ≥6 new tests in `test/pms_invoices.test.js`.

---

## Step 4 — Allocation Auto-Consume + Release Sweep (C7)

### Deliverables
- Migration `0039_pms_allocation_lifecycle.sql` (helper indexes + permissions).
- Repo `pmsRepo` extended with `consumeAllocation / releaseAllocation / listAllocationsDueForRelease`.
- Service `allocationService` with subscribers to `reservation.created` (auto-consume) + `reservation.cancelled` (auto-release).
- Recurring scheduled-job `pms.allocation.release_sweep` (uses Phase 6 scheduler).
- Commands `pms.allocation.consume`, `pms.allocation.release`, `pms.allocation.release_sweep` (system-triggered).
- Routes `POST /api/pms/allocations/:id/release`.

### Schemas
```sql
CREATE INDEX IF NOT EXISTS idx_allocations_property_status
  ON allocations(property_id, status);
CREATE INDEX IF NOT EXISTS idx_allocations_date_release
  ON allocations(date_from, release_days) WHERE status = 'ACTIVE';

INSERT INTO permissions (code, description) VALUES
  ('allocation.release', 'Release an allocation (sweep or manual)')
ON CONFLICT (code) DO NOTHING;
```

### Aggregates
- `allocation` (already exists in Phase 5.5; lifecycle commands added here).

### Events
- `allocation.consumed`, `allocation.released`, `allocation.exhausted`.

### APIs
- `POST /api/pms/allocations/:id/release { reason? }`.

### Permissions
- `allocation.write` (existing) for consume; `allocation.release` (new) for release.

### Settings (catalog)
- `allocations.default_release_days` (int, default 7) — NEW catalog entry.

### Migration Impact
Additive only.

### Test Coverage Requirements
- Reservation created against allocation → `qty_consumed` bumps; event emitted.
- Reservation cancelled → consumed-quantity decremented; event emitted.
- Consuming past `qty_blocked` returns `allocation_exhausted`.
- Release sweep flips status to RELEASED past `release_days`.
- Manual `pms.allocation.release` works for property_admin.

### Acceptance Criteria
- ≥6 new tests in `test/pms_allocations.test.js`.

---

## Step 5 — Voucher Workflow (C6)

### Deliverables
- Migration `0040_pms_vouchers.sql`.
- `pmsRepo` extended with `insertVoucher / findVoucherByNumber / redeemVoucher / cancelVoucher`.
- Commands `pms.voucher.issue`, `pms.voucher.redeem` (accountingSensitive), `pms.voucher.cancel`.
- Hook: `pms.reservation.checkin` extended to accept optional `voucher_number` → auto-redeem.
- Queries `pms.voucher.byNumber`.
- Routes `/api/pms/vouchers*`.

### Schemas
```sql
CREATE TYPE voucher_status AS ENUM ('ISSUED','REDEEMED','EXPIRED','CANCELLED');

CREATE TABLE vouchers (
  id                       UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID            NOT NULL REFERENCES tenants(id),
  property_id              UUID            NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  voucher_number           VARCHAR(40)     NOT NULL,
  agent_guest_id           UUID            REFERENCES guests(id),     -- TA / DMC / Tour
  contract_id              UUID            REFERENCES contracts(id),
  guest_name               VARCHAR(200),
  arrival_date             DATE            NOT NULL,
  departure_date           DATE            NOT NULL,
  room_type_id             UUID            REFERENCES room_types(id),
  status                   voucher_status  NOT NULL DEFAULT 'ISSUED',
  amount                   NUMERIC(14,2)   NOT NULL DEFAULT 0,
  currency                 CHAR(3)         NOT NULL DEFAULT 'LKR',
  issued_at                TIMESTAMPTZ     NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ,
  redeemed_at              TIMESTAMPTZ,
  redeemed_reservation_id  UUID            REFERENCES reservations(id) ON DELETE SET NULL,
  cancelled_at             TIMESTAMPTZ,
  cancellation_reason      TEXT,
  payload                  JSONB           NOT NULL DEFAULT '{}'::jsonb,
  created_by               UUID,
  CHECK (departure_date > arrival_date)
);
CREATE UNIQUE INDEX ux_vouchers_number ON vouchers(property_id, voucher_number);
CREATE INDEX idx_vouchers_agent ON vouchers(agent_guest_id);
CREATE INDEX idx_vouchers_status ON vouchers(tenant_id, status);
ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vouchers FORCE  ROW LEVEL SECURITY;
CREATE POLICY vouchers_by_app ON vouchers
  USING (tenant_id::text = current_setting('app.tenant_id', true));

INSERT INTO permissions (code, description) VALUES
  ('voucher.read',   'Read vouchers'),
  ('voucher.write',  'Issue / cancel vouchers'),
  ('voucher.redeem', 'Redeem a voucher at check-in')
ON CONFLICT (code) DO NOTHING;
```

### Aggregates
- `voucher` (ISSUED → REDEEMED | EXPIRED | CANCELLED).

### Events
- `voucher.issued`, `voucher.redeemed`, `voucher.expired`, `voucher.cancelled`.

### APIs
- `POST /api/pms/vouchers` — issue.
- `POST /api/pms/vouchers/:n/redeem { reservation_id }`.
- `POST /api/pms/vouchers/:n/cancel { reason }`.
- `GET  /api/pms/vouchers/:n`.

### Permissions
- `voucher.read / .write / .redeem` (granted to corporate_admin, property_admin, front_office_manager).

### Settings (catalog)
- `vouchers.default_validity_days` (int, default 90) — NEW.

### Migration Impact
Additive only.

### Test Coverage Requirements
- Issue voucher → status ISSUED + `expires_at` set from setting.
- Redeem voucher → status REDEEMED + linked reservation; check-in attaches voucher_number.
- Double-redeem → `voucher_already_redeemed`.
- Cancel before redemption → CANCELLED; redeem after cancel fails.

### Acceptance Criteria
- ≥6 new tests in `test/pms_vouchers.test.js`.

---

## Step 6 — Group Reservation Lifecycle (C5)

### Deliverables
- Migration `0041_pms_group_lifecycle.sql` (indexes + permissions).
- `pmsRepo` extended with `findGroupById / listGroupReservations / setGroupTotals / cancelAllInGroup`.
- Commands `pms.reservation_group.create`, `pms.reservation_group.add_room`, `pms.reservation_group.cancel_all`, `pms.reservation_group.checkin_all`.
- Queries `pms.reservation_group.byId / .rooming_list`.
- Routes under `/api/pms/reservation-groups`.

### Schemas
```sql
CREATE INDEX IF NOT EXISTS idx_reservations_group_status
  ON reservations(group_id, status) WHERE group_id IS NOT NULL;

-- Permissions already seeded (migration 0030: reservation.group.write)
```

### Aggregates
- `reservation_group` (Phase 5.5 table; lifecycle commands here).

### Events
- `reservation_group.created`, `.room_added`, `.cancelled`, `.checked_in_all`.

### APIs
- `POST /api/pms/reservation-groups` — create.
- `POST /api/pms/reservation-groups/:id/rooms` — add a reservation to group.
- `POST /api/pms/reservation-groups/:id/cancel-all { reason }`.
- `POST /api/pms/reservation-groups/:id/checkin-all`.
- `GET  /api/pms/reservation-groups/:id` + `/rooming-list`.

### Permissions
- `reservation.group.write` (existing).

### Settings (catalog)
- `pms.groups.auto_block_inventory` (boolean, default true) — NEW.
- `pms.groups.cancel_requires_force_when_checked_in` (boolean, default true) — NEW.

### Migration Impact
Additive only.

### Test Coverage Requirements
- Create group + add 3 rooms; rooming list returns 3.
- `cancel-all` refuses if any member is CHECKED_IN unless `force_close=true`.
- `cancel-all` cascades cancellation; emits group event + per-member events.
- `total_rooms` updated on add_room.
- Cross-property add rejected.

### Acceptance Criteria
- ≥6 new tests in `test/pms_reservation_groups.test.js`.

---

## Cross-Cutting Notes

1. **No fake AI / no demo data.** Phase 7 doesn't touch AI surfaces.
2. **Backward compatibility.** Every change is additive. Existing folio commands continue to work; voucher hook on check-in is optional.
3. **Property-ID enforcement.** Every new command requires `ctx.propertyId`. Cross-property pairings (folio↔invoice, voucher↔reservation, group↔room) explicitly rejected with dedicated error codes.
4. **Audit-enabled.** All new commands flow through commandBus → audit pipeline. New event types all match the single-dot regex (`voucher.issued`, `invoice.voided`, `allocation.consumed`, etc.).
5. **Business-date aware.** Invoice creation, payment posting, voucher redemption all stamp `business_date` from `ctx.businessDate`. Night Audit will eventually subscribe to these (Phase 8 Finance).
6. **Settings Center sole source.** Every new tunable lands in `settingsCatalogBoot.js`.
7. **accountingSensitive enforcement.** Payment allocation, invoice issue/void, voucher redeem, folio cash payment, allocation consume all flagged. Night Audit lock blocks them as designed in Phase 5.5.

## Test Totals Targets

| Step | New tests (min) | Cumulative pass target |
|------|-----------------|------------------------|
| 1 — C8 payment allocation     | +7  | 297 |
| 2 — C10 cash change           | +5  | 302 |
| 3 — C9 invoice aggregate      | +6  | 308 |
| 4 — C7 allocation lifecycle   | +6  | 314 |
| 5 — C6 voucher workflow       | +6  | 320 |
| 6 — C5 group lifecycle        | +6  | 326 |
| migrationValidation + architectureReadiness extensions | +4 | **330** |

Final target: **≥ 330 / 330 backend tests passing.** Frontend unchanged.

## Done When

- All five migrations (0037–0041) committed.
- All step tests + existing tests pass green in one run.
- `docs/QYRVIA_COMPLIANCE_ASSESSMENT.md` C5–C10 rows flipped from ✗/◐ to ✓.
- `docs/PHASE_7_COMPLETION_REPORT.md` published with binding-constraints checklist.
- Stop notice — awaiting Phase 8 brief.
