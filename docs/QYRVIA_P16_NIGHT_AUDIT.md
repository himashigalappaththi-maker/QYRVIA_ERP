# QYRVIA Phase 16 — Night Audit / Day-End Engine

> Implements the QYRVIA Business Date architecture: safe transition from one
> business date to the next with financial controls, operational continuity,
> auditability, automatic + manual execution, and strict multi-property
> isolation. Additive / self-contained; JS / CommonJS; consumes Reservation
> (12), Front Desk (13), Billing (14), Housekeeping (15) via events only — never
> modifies them. No schema changes. No AI.

## Modules (`server/src/nightaudit/`)

```
models/NightAuditModels.js          BusinessDate / NightAuditRun / FinancialLock + enums + nextDate
repository/nightAuditRepo.memory.js business dates, runs, locks, exceptions, event activity (property-scoped)
core/BusinessDateEngine.js          per-property date + status (OPEN/AUDIT_PENDING/CLOSED), advance, reopen
core/FinancialLockEngine.js         lock/unlock accounting; operational-continuity guard
core/AuditExceptionEngine.js        FINANCIAL/OPERATIONAL/BILLING/SYSTEM; raise/resolve/history
core/AuditValidationEngine.js       open folios / unbalanced invoices / unposted / incomplete / unresolved
core/NightAuditEngine.js            validateDayEnd / runNightAudit / rollbackAudit / getAuditHistory
core/DayEndScheduler.js             automatic + manual + retry; never blocks login
core/NightAuditDashboard.js         executive + operations views + pending banner
core/NightAuditSystem.js            facade composing all of the above
services/nightAuditSubscriber.js    stay.ended / invoice.finalized / payment.received / housekeeping.task_completed -> activity
```

## Validation flow (runNightAudit)

1. Start a run (RUNNING) and emit `dayend.started`.
2. Mark the business date **AUDIT_PENDING** and **lock** accounting functions
   (so a pending audit restricts accounting while operations continue).
3. Validate readiness (open folios, invoice balance, unposted charges,
   incomplete postings, unresolved external exceptions) → blocking + warnings.
4. **Blocking & not forced** → run FAILED, raise audit exceptions, stay
   AUDIT_PENDING + locked (operations keep working). Fix the cause and retry.
5. Otherwise → generate summary, **advance the business date** (CLOSED → next
   day OPEN), complete the run, reset the day's activity, **unlock**, emit
   `dayend.completed`.

> Audit-derived exceptions are tagged `source: VALIDATION` (audit trail only) so
> they are re-evaluated each run and never perma-block a retry; only
> externally-raised blocking exceptions stop the audit.

## Operational continuity (critical QYRVIA rule)

While an audit is pending, **users can still log in** and Front Desk,
Reservations, Housekeeping, and room-status updates keep working. Only
accounting-sensitive functions are blocked — `FinancialLockEngine.isOperationAllowed(ctx, { accountingSensitive })`
returns `true` for operational actions even when locked. The dashboard shows
**“Business Date Not Closed” / “Night Audit Pending”** until completion.

## Events

Emit: `dayend.started`, `dayend.completed`, `businessdate.changed`,
`audit.exception`, `financial.locked`, `financial.unlocked`.
Subscribe (read-only): `stay.ended`, `invoice.finalized`, `payment.received`,
`housekeeping.task_completed` — these feed the activity tally that default
validation reads (open folios ≈ stays ended − invoices finalized).

## Scheduler

`runManual`, `runAutomatic`, `runDue({ asOfDate })` (sweeps properties whose
business date is behind), and `retryFailed`. It only triggers the audit — it
never gates login or operational modules.

## Tests (`test/night_audit.test.js`) — all green

Business-date lifecycle · successful audit (date advance + event emission) ·
blocking validation failure + force override · financial lock (operational
continuity) · pending-audit banner · scheduler manual/auto-sweep/retry ·
exception raise/resolve · audit history · event-fed validation via subscriber ·
multi-property isolation.

## Success criteria — met

QYRVIA transitions business dates safely with financial controls, preserves
operational continuity, enforces auditability, supports automatic + manual +
retry execution, and isolates properties. No regression; full suite green.
