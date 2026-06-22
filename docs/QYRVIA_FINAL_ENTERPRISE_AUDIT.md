# QYRVIA — Final Enterprise ERP Audit & Compliance Remediation Report

> **Phase 9 — Audit Only.** No code, migrations, schema, routes, commands, or
> UI were changed to produce this report. Every finding below is anchored to a
> file/line or a reproducible command in the current codebase. Where a prior
> Completion Report and the code disagree, the **code is treated as ground
> truth** and the discrepancy is recorded in §12.

**As-of:** 2026-06-22 · **Backend tests:** 350 / 350 passing (`npm test`) ·
**Migrations:** `0001` … `0044` (contiguous) · **Mounted API groups:**
health, auth, core, connector(s), settings, files, webhooks, jobs,
notifications, pms, finance (`src/routes/api.js:30-57`).

---

## §0 — Methodology & Evidence Base

This audit was performed by static inspection of the running codebase plus
execution of the test suite. It does **not** rely on the marketing language or
self-reported scores in the prior Completion Reports.

Evidence sources:

- **Code:** `server/src/**` (commands, queries, services, routes, repos, core).
- **Schema:** `server/src/db/migrations/0001..0044`.
- **Tests:** `server/test/**` (44 files) + `npm test` result (350 pass).
- **Reference docs:** `docs/QYRVIA_COMPLIANCE_ASSESSMENT.md` (Phase-5.5 baseline),
  `docs/PHASE_6_COMPLETION_REPORT.md`, `docs/PHASE_7_COMPLETION_REPORT.md`,
  `docs/PHASE_8_IMPLEMENTATION_PLAN.md`, `docs/ARCHITECTURE_READINESS.md`.

**Status vocabulary used throughout:**

- **Implemented** — code path exists *and* is exercised by an automated test.
- **Wired-not-tested** — production code path exists (`src/index.js` wiring) but
  no automated test exercises it.
- **Framework / Foundation** — abstraction or extension point exists, but the
  concrete behaviour does not.
- **Schema-only** — a table/enum/permission is reserved in a migration, with
  **no** repo, service, command, query, or route referencing it.
- **Missing** — no evidence of any kind.

**Critical cross-cutting caveat (affects every score in this report):** the
entire test suite runs against **in-memory fakes** (`test/_fixtures.js`
`makeFakeDb` / `makeFakeRepos`). **No test executes against PostgreSQL**
(`grep` for `db/client`, `new Pool`, `pool.connect` in `test/` → none).
Therefore **RLS policies, FK constraints, `CHECK` constraints, enum types, and
SQL itself are unverified by CI.** Migrations are validated only as *text*
(`test/migrationValidation.test.js` reads files; it does not run them). This is
the single largest production-readiness risk and is reflected in §7 and §13.

---

## §1 — Remaining Critical Gaps (C11 + C12 Re-Audit)

The Phase-7 report listed **C11 (Cost Center)** and **C12 (Revenue Posting
Mapper)** as the only two open Critical Gaps. Both now have code.

### C11 — Cost Center Accounting

| Capability | Status | Evidence |
|---|---|---|
| Cost-center entity (CRUD) | **Implemented** | `cost_centers` table `0042_finance_cost_centers.sql`; commands `finance.cost_center.create/update/disable` (`commands/finance/costCenters.js`); query `finance.cost_center.list/.byId` (`queries/finance/index.js`); tests `test/finance_cost_centers.test.js` (5). |
| Cost-center **hierarchy** (parent/child) | **Missing** | `0042` defines no `parent_id`. Compliance §5.6 explicitly specified `parent_id`; it was dropped. Flat list only. |
| Department mapping | **Partial** | `type` enum `ROOM/FNB/SPA/ADMIN/OTHER` (`0042:10`) approximates departments; no separate department entity. |
| Revenue allocation to CC | **Implemented (wired)** | Ledger entries carry `cost_center_id`; `ledgerService.postForEvent` stamps it (`services/finance/ledger.js`). Report query `finance.cost_center.report` (`queries/finance/index.js`). |
| **Expense** allocation to CC | **Missing** | No expense/AP posting path exists (see §2). CC is only populated by the three revenue-side bridges. |
| Budget linkage | **Missing** | No `budgets`/`budget_lines` table (Compliance §5.7 still open). |
| Ledger integration | **Implemented** | `cost_center_id` FK on `ledger_entries` (`0044`). |
| Reporting integration | **Partial** | `finance.cost_center.report` aggregates debit/credit by CC, but only over the minimal ledger; not over a real GL. |

**Verdict: Partially implemented.** A flat cost-center registry with
revenue-side ledger tagging exists. Hierarchy, expense allocation, and budget
linkage — all named in the original requirement — are absent.

### C12 — Revenue Posting Mapper

| Capability | Status | Evidence |
|---|---|---|
| Revenue code mapping (event → accounts) | **Implemented** | `revenue_posting_map` (`0043`); commands `finance.revenue_map.upsert/.delete`; `ledgerService.resolveForEvent` hard-fails on missing map (`services/finance/ledger.js`). |
| Missing-mapping = HARD FAIL (no fallback) | **Implemented & tested** | `test/finance_ledger.test.js` → "invoice issue HARD FAILS when no revenue mapping exists". |
| **Tax** mapping | **Missing** | `invoices.tax_amount` is hardcoded to `0` (`commands/pms/invoices.js`: `const tax = 0`). No tax tables, no tax-code → account mapping. |
| **Service-charge** mapping | **Missing** | No service-charge concept anywhere. |
| Department mapping | **Partial** | Via `revenue_posting_map.cost_center_id` only. |
| Ledger account mapping | **Implemented** | `debit_account` / `credit_account` free-text columns (`0043`). Note: accounts are **free text**, not FKs to a chart of accounts (none exists). |
| **Night-Audit posting integration** | **Missing** | The mapper fires inline from invoice/voucher/payment commands, **not** from Night Audit. `services/pms/nightAudit.js` has no ledger step. Compliance §5.8 / §2.3 expected revenue posting to be a Night-Audit subscriber; it is not. |
| Multi-property behaviour | **Implemented** | Map keyed `(tenant_id, property_id, event_type)` (`0043:23`); cross-property cost-center rejected (`revenue_map.upsert` + `resolveForEvent`). Tested. |

**Verdict: Partially implemented.** The core "no hardcoded accounting, hard-fail
on missing map" guarantee is real and tested. Tax, service charge, chart-of-
accounts FKs, and Night-Audit integration are not built.

> **Note on event names:** the brief specified `ledger.entry.created`,
> `ledger.batch.posted`, `revenue_mapped`. `makeEvent` enforces a single-dot
> `aggregate.verb` type (`core/event.js:27`), so the implementation emits
> `ledger.entry_created`, `ledger.batch_posted`, `ledger.imbalance_rejected`,
> `revenue.mapped`. Functionally equivalent; named differently from the brief.

---

## §2 — Enterprise Finance Audit

| Area | Status | Evidence / Note |
|---|---|---|
| General Ledger (full) | **Schema-only / Missing** | The *real* GL tables `finance_ledger_accounts` + `finance_journal_entries` (`0029`) are **not referenced by any repo/service/command/query** (verified by grep). The only working ledger is the **minimal** Phase-8 `ledger_entries`/`ledger_batches` (`0044`) — a double-entry backbone, not a GL with a chart of accounts. |
| Chart of Accounts | **Missing** | No CoA table. Ledger accounts are free-text strings on `revenue_posting_map`. |
| Accounts Receivable | **Partial** | AR arises implicitly (invoice debits an `AR` account string; payment credits it). No AR sub-ledger, no aging buckets, no statements (Compliance §5.4 still open). |
| Accounts Payable | **Missing** | No `vendor_bills`/`vendor_payments` (Compliance §5.5 open). `procurement_purchase_orders` is schema-only. |
| Journal Entries (manual) | **Partial** | `finance.ledger.post` accepts arbitrary balanced entries, but there is no journal/period/posting-status model; entries are immutable rows, reversible via `finance.ledger.revert`. |
| Trial Balance | **Missing** | No trial-balance query. `finance.revenue.summary` only sums `INVOICE` credits. |
| Cost Centers | **Partial** | See §1 (flat, revenue-side only). |
| Budget Controls | **Missing** | No budgets. |
| Revenue Posting | **Partial** | See §1 C12. Inline, not Night-Audit-driven. |
| Financial Closing | **Missing** | Night Audit advances the business date (`services/pms/nightAudit.js`) but performs **no** period close, no revenue snapshot, no GL roll-forward. Compliance §2.3 flagged the subscriber steps as module work; they remain unbuilt. |
| Inter-property accounting | **Missing** | No `intercompany_transfers` (Compliance §1.13 / H5 open). |
| Consolidation | **Missing** | No consolidated/group financial query. |
| Multi-currency | **Partial (storage only)** | `currency` columns default `'LKR'` on folios/invoices/ledger. **No FX rate table, no conversion, no revaluation.** A ledger batch cannot mix currencies meaningfully. |
| Tax architecture | **Missing** | `tax_amount` hardcoded `0`; no tax codes, rates, jurisdictions, or filing. |
| Revenue recognition | **Missing** | Revenue posts at invoice issue, not per-night earned. No recognition schedule. |
| Deferred revenue | **Missing** | No advance-deposit liability handling (Compliance §5.9 open). |
| Audit trails | **Implemented** | Every command audited via `runWithAudit` (`audit/pipeline.js`); events dual-persisted to `audit_events` + `event_store`; both append-only (`REVOKE UPDATE,DELETE`). Ledger entries append-only (`0044`). |
| Segregation of duties | **Partial** | RBAC permissions exist (`ledger.revert` restricted to `corporate_admin`, `0044`); accounting-sensitive lock (`commandBus.js:80`). **No maker-checker / dual-approval / command-pair conflict matrix.** |

**Finance verdict:** A **transactional finance + minimal double-entry ledger**
exists and is internally consistent (balanced-or-reject is real and tested). It
is **not** an enterprise accounting system: no chart of accounts, GL, AP, trial
balance, tax, multi-currency conversion, budgets, closing, or consolidation.

---

## §3 — Multi-Property Audit

| Capability | Status | Evidence |
|---|---|---|
| Property switcher (no logout) | **Implemented** | `POST /api/auth/switch-property` re-issues tokens, re-validates target role (`routes/auth.js`; Phase-6 report); tests `auth_multiproperty.test.js`. |
| Property isolation (app-level) | **Implemented** | `ctx.propertyId` flows everywhere; repo queries scope by `property_id`; cross-property pairings refused (e.g., `revenue_map.upsert` cost-center check). Tested in `pms_isolation_and_businessdate.test.js`, `finance_ledger.test.js`. |
| Property isolation (DB RLS) | **Partial / unverified** | RLS is **tenant-scoped only** (`current_setting('app.tenant_id')`), not property-scoped (intentional per Compliance §1.10). And RLS is **never exercised by tests** (no DB in CI). |
| Tenant isolation | **Implemented (app) / unverified (DB)** | `tenant_isolation.test.js` covers app logic; RLS itself untested. |
| Cross-property transfers | **Missing** | No transfer aggregate of any kind. |
| Inventory transfers | **Missing** | Compliance §1.11 open; `inventory_*` schema-only. |
| Financial transfers (inter-property) | **Missing** | Compliance §1.13 / H5 open. |
| Shared users / multi-property roles | **Implemented** | `user_roles.property_id`; `listAccessibleProperties`; `GET /api/auth/properties`. Tested. |
| Corporate reporting | **Missing** | No cross-property roll-up query. Finance reports are single-property (`finance.*.report` require `ctx.propertyId`). |
| Consolidated reporting | **Missing** | None. |
| Central procurement | **Missing** | Compliance §1.12 open; procurement schema-only. |
| Property / company hierarchy | **Partial** | `tenants` → `properties` exists; no multi-level company/region/brand hierarchy. |
| Corporate permissions | **Implemented** | `corporate_admin` / `property_admin` roles seeded; scope on `user_roles`. |

**Multi-property verdict:** **Identity & isolation are solid**; **operational and
financial cross-property workflows (transfers, consolidation, central
procurement, corporate reporting) are entirely absent.**

---

## §4 — Hotel Operations Audit

| Module | Status | Evidence |
|---|---|---|
| Reservations | **Implemented** | `pms.reservation.create/confirm/checkin/checkout/cancel`; occupancy + child-policy engines; tests `pms_reservations.test.js`. |
| Groups | **Implemented** | `pms.reservation_group.create/add_room/cancel_all/checkin_all`; `pms_reservation_groups.test.js`. |
| Contracts | **Schema-only** | `contracts`/`contract_rates` reserved (`0024`); **no contract commands/queries** in inventory. Reservations carry `contract_id` FK only. |
| Allocations | **Implemented** | `pms.allocation.create/release/release_sweep` + auto-consume/release subscribers (`index.js`); `pms_allocations.test.js`. |
| Vouchers | **Implemented** | `pms.voucher.issue/redeem/cancel`; `pms_vouchers.test.js`; redeem now bridges to ledger. |
| Check-in / Check-out | **Implemented** | `pms.reservation.checkin/checkout`; folio opened on check-in; `pms_checkin_folio.test.js`. |
| Housekeeping | **Implemented** | `pms.housekeeping.task.create/assign/complete`; room-status workflow; tests present. |
| Maintenance | **Missing** | No `maintenance_work_orders` (Compliance §8.4 open). Only `guest_service_requests` category reserved. |
| Front Office | **Partial** | Folio charges/payments/cash/close, invoices implemented; no shift/cashier-drawer/handover model. |
| Night Audit | **Partial** | `pms.night_audit.run` advances date + locks; scheduler + stale-date alert (Phase 6). **No financial posting steps** (no room-charge posting, no revenue snapshot, no ledger close). |
| Folio / Invoicing | **Implemented** | `pms.folio.charge.post/close`, `payment.allocate/cash`, `pms.invoice.issue_from_folio/void`; multiple test files. |
| Guest CRM | **Schema-only** | `crm_interactions`, `loyalty_*` reserved (`0028`); no commands/routes. |
| POS / QR Ordering / Contactless | **Schema-only** | `restaurant_outlets/tables/menu_items/pos_orders/...` reserved (`0028`); no commands/routes. |
| Inventory | **Schema-only** | `inventory_items/stock_levels` reserved (`0029`). |
| Procurement | **Schema-only** | `procurement_purchase_orders` reserved (`0029`). |
| HR / Payroll | **Schema-only** | `hr_employees`, `payroll_periods` reserved (`0029`); no attendance, no payroll engine. |
| Asset Management | **Schema-only** | `fixed_assets` reserved (`0029`). |
| Gate Pass | **Schema-only** | `gate_passes` reserved (`0029`). |
| Mobile Key / Digital Key | **Schema-only** | `access_keys`/`access_logs` reserved (`0027`); no issue/revoke commands. |

**Operations verdict:** **PMS core (reservation → folio → invoice) is genuinely
implemented and tested.** Everything downstream of the front desk (POS,
inventory, procurement, HR, payroll, CRM, loyalty, assets, gate pass, mobile
key, maintenance) is **schema-only** — reserved tables with no behaviour.

---

## §5 — AI Platform Audit

**Explicit finding: there is no functioning AI in this system.** This is not a
criticism of honesty — there are no *fake* or *mock* AI outputs either (the
prior reports' "no fake AI" claim holds). There is simply no AI behaviour.

| AI Capability | Classification | Evidence |
|---|---|---|
| AI Copilot | **Missing** | No command/route/service. `ai_conversations.channel='COPILOT'` is schema-only (`0028`). |
| AI Revenue Forecasting | **Missing** | `revenue_snapshots` schema-only; no engine. |
| AI Business Intelligence | **Missing** | No BI queries/datasets. |
| AI CRM Automation | **Missing** | No CRM module at all. |
| AI WhatsApp Booking Agent | **Missing** | No WhatsApp adapter; channel reserved only. |
| AI Reputation Management | **Missing** | `reviews`/`reputation_scores` schema-only. |
| AI Analytics / Recommendations | **Missing** | None. |
| **AI Provider Architecture** | **Framework Exists** | `providers/connectorAdapters.js` defines `anthropic`/`openai`/`openrouter`/`gemini` adapters — but each only implements `capabilities()` and `probe()` (a **credential/health check**, e.g. lines 26-90). **There is no `chat()`/inference call, no AI gateway, no prompt execution.** The Compliance §14.6 "aiGateway.chat()" was never built. |
| AI Audit Controls | **Partial (generic)** | If AI ever dispatched a command it would be audited (generic pipeline); `ai_conversations`/`ai_messages` are append-only (`0036`). No AI-specific audit exists because no AI runs. |
| AI Cost Controls | **Missing** | No token/spend accounting. |
| AI Prompt Management | **Missing** | No prompt store/versioning. |
| AI Data Governance | **Missing** | No AI data-handling policy in code. |

**AI verdict:** **Provider abstraction = Framework Exists. Every actual AI
feature = Missing.** AI maturity is effectively 0% functional, ~10% if credit is
given for the provider probe layer and reserved conversation tables.

---

## §6 — Security Audit

| Control | Status | Evidence |
|---|---|---|
| RBAC | **Implemented** | Per-command `permission` enforced in `commandBus.js:66-74`; `super_admin` bypass; route-level `requirePermission`. Tested `rbac.test.js`. |
| Property isolation | **Implemented (app)** | See §3. |
| Tenant isolation | **Implemented (app) / unverified (DB RLS)** | See §3. RLS present in every migration but never executed in tests. |
| Audit events | **Implemented** | `audit/pipeline.js`; every command/query attempt recorded. |
| Event store | **Implemented** | Dual-persist domain events (`index.js` `insertDomainEvent`). |
| Append-only controls | **Implemented** | `REVOKE UPDATE,DELETE` on `audit_events`, `event_store`, `ai_*`, `ledger_entries`. Verified as *text* in `migrationValidation.test.js` (not at DB level). |
| Permission seeds | **Implemented** | Seeded per migration + reserved set (`0030`). |
| Authentication | **Implemented** | `bcryptjs` password hashing (`services/identity.js`, `docs/PASSWORD_MIGRATION.md`); login by tenant_code or property_code. |
| JWT security | **Implemented** | `jsonwebtoken`; tenant/property claims; spoofed `X-Tenant-Id` rejected (`securityMiddleware.test.js`). JWT secret length validated. |
| Rate limiting | **Partial** | **Only `POST /api/auth/login`** is rate-limited (5/window, `routes/auth.js:31-44`). No global API throttle, no per-tenant quota. |
| Secrets handling | **Partial** | Provider API keys are env-only, never persisted (good). But no secret-rotation, no vault integration; `.env.example` only. |
| PII controls | **Missing** | Guest PII (name/email/mobile) stored plaintext; no field-level encryption, no tokenisation, no masking. |
| GDPR readiness | **Missing** | No right-to-erasure, no data-subject export, no consent model (grep for `gdpr/retention/erasure` → none in code). |
| Activity logs | **Implemented** | = audit events. |
| Data retention | **Missing** | No retention policy, no purge job; `audit_events`/`event_store`/`ledger_entries` grow unbounded. |
| Disaster recovery | **Missing** | No backup/restore tooling, no PITR config, no documented RPO/RTO. |
| Input hardening | **Implemented** | `sanitizeJsonBody` (depth/length caps), `securityHeaders`, 256kb body cap (`app.js:50-56`). |

**Security verdict:** **Strong application-layer auth/RBAC/audit foundation.**
Material gaps: rate limiting is login-only, **RLS is unverified by any test**,
and **PII/GDPR/retention/DR are entirely absent** — blockers for handling real
guest data in regulated markets.

---

## §7 — Performance & Scalability Audit

| Concern | Finding | Evidence |
|---|---|---|
| Indexes | **Adequate for current scope.** Tenant/property/time and reference indexes exist on hot tables (e.g., `idx_ledger_entries_reference`, `idx_audit_events_property_time` `0035`, folio/reservation indexes). | migrations |
| Query patterns | **Mostly simple, single-table, tenant-scoped.** No ORM; raw parameterised SQL. | `db/repos.js` |
| **N+1 risks** | **Present.** `paymentAllocationService.allocate` issues one `listAllocationsForCharge` query **per charge line in a loop** (`services/pms/paymentAllocation.js`, `for (const c of chargeLines) { await ... }`). `ledgerRepo.revertBatch` inserts entries one-by-one in a loop. Acceptable at small scale; degrades on large folios/batches. | code |
| Large-table risk | **High, unmitigated.** `audit_events`, `event_store`, `ledger_entries` are append-only with **no partitioning** (`grep PARTITION` → none) and **no archival**. | migrations |
| Audit / event-store growth | **Unbounded.** Every command writes ≥1 audit row; domain events write to two tables. No TTL/rollup. | `eventBus.js`, `index.js` |
| Ledger growth | **Unbounded.** 2+ rows per financial event, plus reversals. No period archival. | `0044` |
| Archival strategy | **Missing.** | — |
| Night-Audit scalability | **Unknown / low confidence.** Stale-check sweeps all properties (`listPropertiesWithStaleBusinessDate`); single-process scheduler (`core/scheduler.js`), in-memory event bus (`eventBus.js` explicitly notes "Phase 5+ will swap for a real queue"). No horizontal scaling. | code |
| 100 / 500 / 1000-property scenarios | **Not demonstrable.** No load tests, no benchmarks, no connection-pool tuning evidence, in-memory bus + single scheduler = vertical-only. Cannot substantiate any property-count target. | — |

**Performance verdict:** Fine for a single property / pilot. **No evidence
supports 100/500/1000-property operation**: in-memory event bus, single
scheduler process, unbounded append-only tables without partitioning/archival,
and known N+1 loops. These are architectural, not tuning, gaps.

---

## §8 — Compliance Scorecard (Evidence-Based)

Scores are deliberately conservative and **separate "schema present" from
"behaviour implemented & tested."** They are lower than the Completion Reports'
self-reported 96–98% because those numbers credited *foundation/◐ partial* rows
at high weight. This audit weights **working, tested behaviour**.

| Dimension | Reported (Phase 7/8 docs) | **Audited (this report)** | Basis |
|---|---|---|---|
| Overall Architecture Compliance | ~98% | **~62%** | Strong kernel + PMS + folio + minimal ledger; most ERP modules schema-only. |
| Production Readiness | not stated | **~35%** | No DB-level tests, no PII/GDPR/DR/retention, login-only rate limit, in-memory bus. |
| Enterprise ERP (GL/AP/AR/Tax/Budget/Consolidation) | implied high | **~20%** | Only minimal ledger + cost centers exist; GL/AP/Tax/Budget/Consolidation missing. |
| Hospitality ERP (operations) | ~96% | **~55%** | PMS+folio+groups+vouchers+allocations real; POS/inventory/procurement/HR/maintenance/CRM/mobile-key schema-only. |
| AI Maturity | "foundation" | **~8%** | Provider probe layer only; zero functional AI. |
| Multi-Property | ~92% | **~55%** | Identity/isolation strong; transfers/consolidation/corporate reporting missing. |
| Financial Control Compliance | implied high | **~45%** | Balanced-ledger guarantee + audit + accounting-lock real; no SoD/maker-checker, tax, closing, deferred revenue. |
| Security | ~strong | **~60%** | Auth/RBAC/audit strong; RLS untested, PII/GDPR/DR/retention absent. |
| Scalability | "100-property ready" claims | **~25%** | No load evidence; in-memory bus, single scheduler, unbounded tables. |

> **None of the 100% targets in the Phase-9 brief are met today.** The honest
> position: this is a **well-architected PMS + folio kernel with a minimal
> finance ledger**, ~60% of the way to "enterprise hospitality ERP" by
> architecture, far less by functional module coverage.

---

## §9 — Final Roadmap (Gap Register)

Only gaps that block the stated 100% targets are listed. Effort is in
engineer-weeks (EW), rough order-of-magnitude.

### Phase 9 (Production-Readiness Hardening) — **highest priority**

| ID | Gap | Priority | Risk | Business Impact | Effort | Depends on |
|---|---|---|---|---|---|---|
| P9-1 | **DB-backed integration tests** (run migrations + exercise RLS/FK/CHECK against real Postgres in CI) | Critical | Silent schema/RLS breakage ships to prod | Correctness of every isolation & finance guarantee | 2 EW | CI Postgres service |
| P9-2 | **PII protection** (field encryption/tokenisation for guest contact data) | Critical | Data-breach / legal | Cannot legally hold EU/UK guest data | 3 EW | — |
| P9-3 | **GDPR**: data-subject export + right-to-erasure + consent | Critical | Regulatory | Market access | 3 EW | P9-2 |
| P9-4 | **Data retention + archival** for audit/event/ledger (partitioning + purge) | High | Unbounded growth, cost, query slowdown | Long-term viability | 3 EW | — |
| P9-5 | **DR**: documented backup/PITR/RPO/RTO + restore drill | High | Total data loss | Enterprise sales blocker | 2 EW | — |
| P9-6 | **Global + per-tenant rate limiting** (beyond login) | High | DoS / noisy-neighbour | Stability | 1 EW | — |
| P9-7 | **Durable event bus** (replace in-memory `eventBus`) + multi-instance scheduler | High | Lost events on crash; no HA | Scalability/HA | 4 EW | — |
| P9-8 | **Boot-wiring test** for `index.js` (command registration smoke test) | Medium | Silent command-drop regressions (see §12) | Reliability | 0.5 EW | — |

### Phase 10 (Finance Completion)

| ID | Gap | Priority | Risk | Impact | Effort | Depends on |
|---|---|---|---|---|---|---|
| P10-1 | **Chart of Accounts** + wire real GL (`finance_ledger_accounts`/`finance_journal_entries`) or formalise the minimal ledger as GL | Critical | No true accounting | Finance credibility | 4 EW | P9-1 |
| P10-2 | **Tax architecture** (codes, rates, jurisdiction, posting) | Critical | Fiscal non-compliance | Invoicing illegal in many markets | 4 EW | P10-1 |
| P10-3 | **Night-Audit revenue posting** (move C12 mapper into NA + room-charge posting + revenue snapshot) | High | Finance ≠ operations reconciliation | Daily close correctness | 3 EW | P10-1 |
| P10-4 | **Accounts Payable** (vendor bills/payments) | High | Half a ledger | AP ops | 4 EW | P10-1 |
| P10-5 | **AR aging + statements** | High | Collections | Cash flow | 2 EW | P10-1 |
| P10-6 | **Trial balance + financial closing + period locks** | High | No close | Audit/finance | 3 EW | P10-1 |
| P10-7 | **Budgets + variance**; **cost-center hierarchy + expense allocation** | Medium | Limited control | FP&A | 3 EW | P10-1 |
| P10-8 | **Multi-currency** (FX rates, conversion, revaluation) | Medium | Single-currency only | International chains | 4 EW | P10-1 |
| P10-9 | **Deferred revenue / revenue recognition** | Medium | GAAP/IFRS gap | Regulated markets | 3 EW | P10-3 |
| P10-10 | **Inter-property / intercompany + consolidation + corporate reporting** | Medium | No group view | Chains | 4 EW | P10-1 |
| P10-11 | **Segregation of duties / maker-checker** | Medium | Internal-control gap | Larger orgs | 2 EW | — |

### Phase 11 (Operational Module Build-Out — only the schema-only modules a target market actually needs)

| ID | Gap | Priority | Effort | Note |
|---|---|---|---|---|
| P11-1 | POS / QR ordering / contactless | Market-dependent | 6 EW | tables reserved (`0028`) |
| P11-2 | Inventory + transfers + central procurement | Market-dependent | 6 EW | `0029` reserved |
| P11-3 | Maintenance work orders | Medium | 2 EW | §8.4 |
| P11-4 | Mobile key issue/revoke lifecycle | Medium | 3 EW | `0027` reserved |
| P11-5 | HR attendance + payroll | Market-dependent | 8 EW | `0029` reserved |
| P11-6 | CRM / loyalty | Market-dependent | 4 EW | `0028` reserved |
| P11-7 | Channel manager (booking import/modify/cancel, restrictions) | High for OTA-reliant | 6 EW | Compliance §6 |
| P11-8 | Reputation ingestion | Medium | 3 EW | §13 |
| P11-9 | **AI** (gateway `chat()` + copilot + forecasting) — *only after data/finance are real* | Low until above done | 6+ EW | provider probes exist |

> Phases beyond 11 (AI maturity, advanced revenue management) should not begin
> until P9 (production readiness) and P10 (real finance) are complete.

---

## §10 — Evidence Index (selected file/line anchors)

- Command permission + accounting-lock: `src/core/commandBus.js:66-85`
- Single-dot event-type rule: `src/core/event.js:27`
- In-memory event bus (notes future queue): `src/core/eventBus.js:1-17, 65-88`
- Minimal ledger schema + append-only + CHECKs: `src/db/migrations/0044_finance_ledger.sql`
- Reserved (unwired) real GL: `src/db/migrations/0029_arch_enterprise_reservations.sql:128-159`
- Revenue map hard-fail: `src/services/finance/ledger.js` (`resolveForEvent`)
- Tax hardcoded to zero: `src/commands/pms/invoices.js` (`const tax = 0`)
- N+1 in allocation: `src/services/pms/paymentAllocation.js` (per-charge `await`)
- AI provider probes only (no inference): `src/providers/connectorAdapters.js:26-141`
- Mounted routes (no ai/hr/pos/inventory/procurement/crm): `src/routes/api.js:46-57`
- Login-only rate limit: `src/routes/auth.js:31-44`
- Tests use fakes only: `test/_fixtures.js` (`makeFakeDb`, `makeFakeRepos`)
- Migration text-only validation: `test/migrationValidation.test.js`

---

## §11 — Test & Migration Inventory

- **Migrations:** 44 (`0001`–`0044`), contiguous; validated as text by
  `migrationValidation.test.js`. **0 executed against a database in CI.**
- **Test files:** 44; **350 assertions/tests pass.** Coverage is strong for
  PMS core, folio, vouchers, allocations, groups, settings, auth, webhooks,
  and the Phase-8 ledger (`finance_ledger.test.js`, 13 tests).
- **Coverage gaps:** no DB/RLS tests; no `index.js` boot test; no load/perf
  tests; no security/pentest harness; schema-only modules have no tests
  (correctly, since they have no behaviour).

---

## §12 — Code ↔ Completion-Report Discrepancies (Truth Reconciliation)

1. **C11 hierarchy dropped.** Compliance §5.6 specified `cost_centers.parent_id`;
   `0042` ships a **flat** table. The Phase-8 plan silently omitted hierarchy.
2. **Revenue posting is inline, not Night-Audit-driven.** Compliance §5.8/§2.3
   and the Phase-8 plan ("subscriber inside Night Audit") describe NA
   integration; the implementation fires the mapper inline from
   invoice/voucher/payment commands. NA has no ledger step.
3. **Phase-7 flows produce ledger output only in production wiring.** The
   Phase-8 plan said Phase-7 tests would seed finance defaults via a helper;
   instead `ledgerService` was made an **optional** dependency, so Phase-7 unit
   tests run **without** ledger posting. The bridge is therefore
   **wired-not-tested** in the Phase-7 suites; it is tested only in
   `finance_ledger.test.js`.
4. **Latent boot bugs existed.** `src/index.js` referenced `eventBusRef`,
   `settingsService`, and `scheduler` **before declaration**; the resulting
   `ReferenceError`s were swallowed by boot `try/catch` blocks, meaning
   invoice/voucher/reservation-group commands **silently failed to register in
   production**. (These were corrected during Phase-8 wiring; there is still no
   test guarding `index.js`, so the class of bug can recur — see P9-8.)
5. **Self-reported scores are inflated** relative to functional coverage. The
   96–98% figures count reserved schema and ◐-partial rows at full/half weight.
   This audit's §8 reflects working, tested behaviour.

---

## §13 — Production-Readiness Checklist

| Item | Ready? | Note |
|---|---|---|
| Automated tests green | ✅ | 350/350, but fakes only |
| DB migrations apply cleanly | ❓ | Never executed in CI; `0044` not run against a DB yet |
| RLS verified | ❌ | No DB test |
| Auth / RBAC | ✅ | Tested at app layer |
| Rate limiting | ⚠️ | Login only |
| PII / GDPR | ❌ | Absent |
| Backups / DR | ❌ | Absent |
| Observability (logs) | ✅ | `pino` structured logs + audit trail |
| Metrics / tracing | ❌ | None found |
| Secrets management | ⚠️ | env-only, no rotation/vault |
| Horizontal scalability | ❌ | In-memory bus, single scheduler |
| Data growth management | ❌ | No partitioning/archival |
| CI boot/wiring test | ❌ | `index.js` untested |
| Real finance (GL/AP/tax) | ❌ | Minimal ledger only |

**Go/No-Go:** **No-Go for enterprise/regulated production.** Suitable for a
**single-property functional pilot** behind a trusted boundary, provided the DB
is provisioned and migrations are applied manually.

---

## §14 — Assumptions & Limitations of This Audit

- This audit inspected the **backend (`server/`) only**. The root
  `QYRVIA_ERP_V35-1.html` (~2.9 MB single-file UI) was **not** analysed for
  behaviour; the Completion Reports state it is byte-identical/untouched, and no
  server code references it, so UI-side requirements ("property switcher UI",
  "QR menu UI", etc.) cannot be confirmed and are scored on backend capability
  only.
- No runtime/DB environment was available, so all findings are **static** plus
  the in-memory test run. Claims about RLS/constraints reflect schema text, not
  observed enforcement.
- "Schema-only" means *no server reference found by grep*; a future or external
  consumer of those tables, if any, was not searched for.
- Scores in §8 are **judgement-based** but anchored to the binary
  implemented/tested evidence above; they are intended to be conservative.

---

## §15 — Conclusion & True Remaining Gaps

QYRVIA today is a **clean, well-layered CQRS/event-sourced backend kernel** with
a **genuinely implemented PMS core** (reservations, groups, allocations,
vouchers, check-in/out, housekeeping, folio, invoicing) and a **new, correct,
minimal double-entry ledger** (balanced-or-reject, hard-fail on missing revenue
map, cost-center tagging, append-only, idempotent) — all backed by a strong
audit/RBAC/multi-property-identity foundation.

It is **not yet** an enterprise hospitality ERP. The **true remaining gaps**, in
priority order, are:

1. **Production-readiness** — DB-level testing, PII/GDPR, retention/archival,
   DR, real rate limiting, durable event bus. *(Blocks any real deployment.)*
2. **Real finance** — chart of accounts, GL, tax, AP, AR aging, trial balance,
   closing, deferred revenue, multi-currency, consolidation, SoD. *(Blocks the
   "Accounting system" claim.)*
3. **Operational breadth** — POS, inventory, procurement, HR/payroll,
   maintenance, CRM/loyalty, mobile key, channel manager, reputation are
   **schema-only**. *(Blocks "complete hospitality ERP".)*
4. **AI** — only a credential-probe provider layer exists; no functional AI.
   *(Blocks every AI claim.)*

The most important corrective action before any further feature work is **P9-1
(DB-backed integration tests)**: until migrations and RLS are exercised against
real PostgreSQL, every isolation and financial-integrity guarantee in this
system is asserted but unproven.

---

*End of audit. No code, schema, routes, commands, or UI were modified to
produce this document.*
