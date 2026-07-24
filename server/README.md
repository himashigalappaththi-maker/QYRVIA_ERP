# QYRVIA Server

Node.js/Express backend for QYRVIA Enterprise Hotel Property Management ERP.
Multi-tenant, multi-property, PostgreSQL with full Row-Level Security.

Current delivery (Phase 62A): RLS-safe T1/T2 login, token rotation, and
property resolution hardening. The system includes:

- **Auth** — JWT + refresh-token rotation, SECURITY DEFINER pre-auth resolvers,
  FORCE RLS on all tenant tables, bcrypt outside transactions.
- **PMS** — reservations, room inventory, rate plans, check-in/check-out, folio,
  housekeeping, night audit, guests, group reservations.
- **Finance** — billing, cost centers, revenue management, dynamic pricing.
- **Channel Manager** — OTA adapter framework, ARI sync, inbound webhook
  dedup, outbound queue/worker, credential store.
- **Platform** — RBAC, IAM, event bus, command bus, observability, scheduler.
- **Operations** — incidents, maintenance work orders, attendance events,
  gate passes, patrol security.
- **Booking Engine** — AI booking confirmation, multi-provider LLM support.
- **Process bootstrap** — pino structured logging, graceful shutdown,
  PostgreSQL pool with `withTenant` tenant-scoping, raw-SQL migration runner.

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

## Architecture (request pipeline)

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

## Row-Level Security

All tenant-scoped tables have `ENABLE + FORCE ROW LEVEL SECURITY`. Policies
gate on `app.tenant_id` GUC set via `withTenant(tenantId, cb)` in `db/client.js`.
Pre-auth lookups use four `SECURITY DEFINER` functions in the `auth_resolvers`
schema (owned by `qyrvia_auth_resolver`, a `BYPASSRLS` NOLOGIN role) so login
can resolve user/tenant identity before a tenant GUC context exists.

Column grants on public tables to `qyrvia_auth_resolver` are applied by
migration `0083_auth_resolvers_grants.sql`. The roles and functions are created
by `scripts/db/phase62a_auth_resolvers_bootstrap.sql` which must be run as a
superuser before the first migration on any new instance.
