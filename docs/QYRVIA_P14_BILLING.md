# QYRVIA Phase 14 — Billing Engine (Core Financial Layer)

> Turns stay events into money reality — the first true financial subsystem.
> Additive and self-contained; JS / CommonJS.
>
> **Architecture purity (critical rule):** Billing **MUST NOT** modify Stay /
> Reservation / Room state. It ONLY reads + subscribes to events + writes
> financial records. It holds no reference to those engines (it is constructed
> with just a repo + eventBus).

## Folio model

```
Folio (1 stay = 1 primary folio)
  - FolioItem  (charges: ROOM | EXTRA | SERVICE_CHARGE | TAX | ADJUSTMENT | DISCOUNT)
  - Payment    (settlements: CASH | CARD | CREDIT | BANK_TRANSFER | VOUCHER)
  - Invoice    (PROFORMA | FINAL; immutable once FINAL)
```

## Modules (`server/src/billing/`)

```
models/FolioModel.js              Folio / FolioItem / Payment + enums + money helpers
repository/billingRepo.memory.js  property-scoped store (folios/items/payments/invoices)
core/TaxEngine.js                 VAT + service charge; inclusive/exclusive; per-property
core/FolioEngine.js               createFolio / addCharge / voidCharge / getBalance / statement
core/ChargeEngine.js              room (daily/hourly) / extras / adjustments
core/PaymentEngine.js             split payments; emits payment.received
core/InvoiceEngine.js             proforma + final; STRICT balancing; lock after finalize
core/BillingEngine.js             facade + per-property tax config
services/billingSubscriber.js     stay.* event wiring (read-only consumption)
```

## Inputs (from Phase 13 only — via events, no engine coupling)

| Event | Billing action |
|---|---|
| `stay.started` | open the stay's folio (idempotent) — optional deposit/pre-auth later |
| `room.charge_started` | post a daily room charge **if** the event carries a rate; otherwise the explicit `postRoomCharge` is the primary path (no coupling to pricing engines) |
| `stay.ended` | generate a proforma (finalization trigger) |

## Tax engine

Per-property `{ vatPct, serviceChargePct, inclusive }`. Service charge applies to
the net; VAT to (net + service charge). Inclusive pricing back-computes the net.
Example: base 200 @ 5% SC + 10% VAT → SC 10, VAT 21, gross **231**.

## Payment rule (STRICT, enforced)

Split payments are allowed (cash/card/credit/…). An invoice **cannot be
finalized unless the folio is exactly balanced** (`sum(payments) ==
sum(charges)`); both underpayment and overpayment are rejected
(`invoice_not_balanced`). Overpayment handling is a deliberate future option.

## Invoice lifecycle

- `generateProforma` — a non-binding snapshot (agents/DMCs/guest preview).
- `finalize` — strict balance check, then a FINAL, **locked** invoice; the folio
  is CLOSED and becomes immutable (further charges/voids raise `folio_closed`;
  re-finalize raises `invoice_already_final`).

## Outputs

- **Guest invoice** — the finalized invoice document (locked).
- **Stay folio statement** — `getStatement` (folio + items + payments + totals).
- **Revenue posting events** (single-dot, through the shared eventBus):
  `folio.posted`, `invoice.finalized`, `payment.received` (plus `folio.created`).

## Multi-property isolation

Every method takes a `ctx` with `propertyId`; the repo is property-scoped — no
cross-property folio is visible or chargeable.

## Tests (`test/billing.test.js`) — all green

Idempotent folio-from-stay · room charge + tax breakdown · void charge · split
payments + strict balanced finalize · overpayment rejection · finalized-invoice
immutability · proforma snapshot · multi-property isolation · event subscriber
(folio on `stay.started`, proforma on `stay.ended`) with no engine coupling.

## Constraints honored

- Billing never mutates Stay / Reservation / Room (no references to them).
- JS / CommonJS; no schema changes (migrations stay 0001–0044); CI green.
- Persistence is store-agnostic (additive billing tables are a deferred drop-in).
