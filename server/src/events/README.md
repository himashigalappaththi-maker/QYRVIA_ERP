# events/

Domain events are the **immutable record of what happened**. They land in
`audit_events` via the eventBus's persistent subscriber.

## Naming

`<aggregate>.<verb_past>` — lowercase, snake_case, single dot.

Examples (when these aggregates are added in later phases):

- `reservation.created`
- `reservation.cancelled`
- `invoice.posted`
- `payment.applied`
- `payroll.run_completed`
- `room.assigned`
- `attendance.recorded`

System / pipeline events (from `audit/pipeline.js`):

- `command.attempted`
- `command.succeeded`
- `command.failed`
- `command.denied`

## Shape

```js
{
  event_id:       uuid,                       // auto
  event_type:     '<aggregate>.<verb_past>',
  aggregate_type: '<aggregate>',
  aggregate_id:   '<domain id>',
  tenant_id:      uuid,                       // from ctx
  property_id:    uuid | null,                // from ctx
  actor_id:       uuid | null,                // from ctx
  request_id:     string,                     // from ctx
  payload:        { ... },                    // domain-specific snapshot
  occurred_at:    ISO timestamp               // auto
}
```

Build via `require('../core/event').makeEvent(...)`. The factory validates
shape and freezes the object.

## Rules

- **Events are derived from successful commands**, not created by HTTP
  handlers. The only exception is `audit/pipeline.js` (system events from
  the command lifecycle itself) and future subscribers that derive secondary
  events.
- **Events are immutable.** `Object.freeze` is applied by `makeEvent`.
- **Events must include `payload`** — even if empty `{}`. The audit table
  defaults to `'{}'::jsonb`, but explicit beats implicit.
- **Naming format is enforced** by `makeEvent`. It throws on bad names.

## Template

`_template.js` shows the factory call shape for reference. Real domain
events are built inline in command handlers — no per-event-type file is
required.
