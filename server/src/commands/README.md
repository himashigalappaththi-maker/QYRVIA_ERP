# commands/

The **only** place business mutations live. Every future business action
(creating a reservation, posting an invoice, running payroll, approving a PO)
is implemented as one file in this directory.

## The contract

Every command exports a record matching this shape:

```js
module.exports = {
  name:          'reservation.create',  // <aggregate>.<verb>, lowercase, snake_case
  aggregateType: 'reservation',
  inputSchema:   { ... },                // Phase 3+: validator reference

  handler: async (input, ctx) => {
    // ctx = { tenantId, propertyId, requestId, actorId }
    // 1. validate input against inputSchema
    // 2. check permission for ctx.actorId
    // 3. apply business rule (read DB via db.withTenant, compute result)
    // 4. return outcome shape:
    return {
      ok: true,
      result: { reservationId: '...', ... },
      events: [
        // one or more makeEvent({...}) records
      ]
    };
    // OR on failure:
    return { ok: false, error: 'machine_code', detail: 'human-readable' };
  }
};
```

## Registration

Each command is registered with the command bus at boot:

```js
const commandBus = require('../core/commandBus');
commandBus.register(require('./reservation.create'));
```

Phase 1 ships an empty registry. Phase 3+ adds real commands.

## Rules

- **No HTTP handler may mutate state directly.** All mutations go through
  `commandBus.dispatch(name, input, ctx)`.
- **Commands have no knowledge of HTTP.** They take `input` + `ctx` and return
  an outcome object.
- **Commands produce events, not raw DB rows for downstream consumers.** The
  audit_events table is the source of truth for what happened; projection
  tables are derived state.
- **Command name format is enforced**: `<aggregate>.<verb>`, lowercase,
  snake_case, single dot.
- **One file per command.** Filename mirrors the command name:
  `reservation.create.js`, `invoice.post.js`, etc.

## Template

Copy `_template.js` when starting a new command. Filename `_template.js` is
ignored by the boot registrar (leading underscore).
