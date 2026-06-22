# audit/

The audit pipeline is the **mandatory hook** every command flows through.
No code path bypasses it because the command bus calls `runWithAudit()` on
every dispatch.

## What gets audited

For every `commandBus.dispatch()` call:

1. `command.attempted` — published **before** the handler runs
2. one of:
   - `command.succeeded` — handler returned `{ ok:true }`
   - `command.failed`    — handler returned `{ ok:false }` with any other error
   - `command.denied`    — handler returned `{ ok:false, error:'permission_denied' }`

Plus, on success, every domain event the handler returned in its `events`
array (e.g. `reservation.created`) is also published and persisted.

All four event types land in the same `audit_events` table.

## Failure semantics

- **If the `command.attempted` audit row cannot be written, the command is
  refused.** Audit integrity outranks availability for write paths. The
  caller gets `{ ok:false, error:'audit_attempt_failed' }`.
- **If the `command.{succeeded|failed|denied}` audit row fails to write, the
  command outcome is returned anyway** — the user-facing operation already
  happened; we log the audit failure loudly. (Future enhancement: outbox
  pattern with retry.)

## Pluggable sinks

Phase 1 has one sink: the eventBus's built-in `audit_events` persistence
subscriber. Later phases can add more sinks (SIEM, external audit log) by
subscribing to `'*'` on the eventBus — no change to `audit/pipeline.js`
required.

## Files

- `pipeline.js` — `runWithAudit(cmd, input, ctx, runHandler)` — the wrapper.
