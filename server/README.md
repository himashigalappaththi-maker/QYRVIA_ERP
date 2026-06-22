# QYRVIA Server — Phase 1

Backend foundation for QYRVIA Enterprise ERP. Phase 1 delivers the kernel
primitives every later phase depends on:

- **Process bootstrap** with structured logging (pino) and graceful shutdown.
- **PostgreSQL connection** with a tenant-scoping helper (`withTenant`).
- **Schema migrations** (raw SQL files, no ORM lock-in).
- **In-memory event bus** with a built-in `audit_events` persistence subscriber.
- **Command bus** that routes every business action through the audit pipeline.
- **`/api` URL surface** stubbed end-to-end (`/health`, `/core/commands/:name`,
  `/connector/:id/probe`, `/connector/:id/health`) so the frontend stops
  seeing network errors against unimplemented routes.

No business features. No auth. That's Phase 2+.

## Quick start

```bash
cd server
npm install
cp .env.example .env          # then edit DATABASE_URL
createdb qyrvia               # or your own
npm run migrate               # applies db/migrations/*.sql in order
npm start                     # listens on PORT (default 3001)
```

Verify:

```bash
curl http://localhost:3001/api/health/live
# {"status":"ok","uptimeSec":12.3}

curl http://localhost:3001/api/health/ready
# {"db":"ok"}   or   503 {"db":"down","error":"..."}

curl -H "X-Tenant-Id: 00000000-0000-0000-0000-000000000000" \
     http://localhost:3001/api/connector/stripe/probe
# {"configured":false,"missing":["BACKEND_NOT_WIRED"]}
```

## Required request headers

| Header | When required | Notes |
|---|---|---|
| `X-Request-Id` | Optional | Server generates one if absent; always echoed in response. |
| `X-Tenant-Id`  | `/api/core/*`, `/api/connector/*` | UUID. Health endpoints exempt. |
| `X-Property-Id`| Optional | UUID. Some commands will require it in later phases. |

## Architecture (Phase 1 surface)

```
HTTP request
   |
   v
[requestId]  -> req.ctx.requestId
   |
   v
[requestContext + tenantContext] -> req.ctx.{tenantId, propertyId, actorId:null}
   |
   v
Route -> commandBus.dispatch(name, input, ctx)
                |
                v
        [audit/pipeline] -> eventBus.publish('command.attempted')
                                         -> audit_events INSERT
        handler.validate(input)
        handler.checkPermission(ctx)
        handler.apply(input, ctx)        -> eventBus.publish('aggregate.event')
                                         -> audit_events INSERT
        [audit/pipeline] -> eventBus.publish('command.{succeeded|failed|denied}')
                                         -> audit_events INSERT
```

## Folder layout

```
src/
  index.js              process entrypoint
  app.js                express factory (no listen)
  config/
    env.js              validates env at boot
    logger.js           pino + request_id correlation
  db/
    client.js           pg pool + withTenant(tenantId, cb)
    migrate.js          raw-SQL migration runner
    migrations/
      0001_init.sql     tenants, properties, audit_events, RLS enabled
  core/
    eventBus.js         in-memory pub/sub + audit_events persistence
    event.js            domain event factory + validator
    commandBus.js       command dispatcher
  commands/             FUTURE business actions (interface only)
    _template.js
    README.md
  events/               FUTURE domain events (interface only)
    _template.js
    README.md
  audit/                MANDATORY pipeline hook
    pipeline.js
    README.md
  middleware/
    requestId.js
    requestContext.js
    tenantContext.js
    error.js
  routes/
    api.js
    health.js
    core.js             POST /api/core/commands/:name -> commandBus
    connector.js        stubs returning not_configured
test/
  app.test.js
  eventBus.test.js
  commandBus.test.js
```

## Tests

```bash
npm test
```

Uses Node's built-in `node:test` runner — no extra deps.

## Row-Level Security note

Phase 1 enables RLS on `tenants`, `properties`, `audit_events` but
**intentionally adds no policies yet** — policies arrive in Phase 3 (Auth)
when the session can issue `SET LOCAL app.tenant_id`. The application contract
is already correct: every query that should be tenant-scoped goes through
`withTenant(tenantId, cb)` in `db/client.js`. When Phase 3 lands the policies,
no application code changes.
