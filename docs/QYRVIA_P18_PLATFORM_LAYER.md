# QYRVIA Phase 18 — Enterprise Cross-Cutting Platform Layer

> Industrializes QYRVIA into a production-grade multi-tenant enterprise SaaS
> platform: Security/IAM, API gateway & governance, observability, integration
> hub, and a multi-property enterprise control layer. Additive and
> self-contained; JS / CommonJS; consumes Phases 11–17 strictly via
> events/APIs. **No core PMS modification. No AI/LLMs. No schema changes.**

## Module structure (`server/src/platform/`)

```
iam/RBACEngine.js               roles + wildcard perms + inheritance + deny-by-default
iam/PolicyEngine.js             ALLOW/DENY + reason; property isolation
iam/AuthService.js              login/logout/refresh/validate (in-memory sessions)
gateway/RateLimiterEngine.js    deterministic fixed-window limiter (per user/property/endpoint)
gateway/RequestContextEngine.js userId/propertyId/role/requestId/sessionId/businessDate
gateway/APIGateway.js           auth -> context -> RBAC/policy -> isolation -> rate limit -> audit
observability/LogEngine.js      structured logs (debug/info/warn/error)
observability/MetricsEngine.js  counters + latency aggregates
observability/TraceEngine.js    correlationId-keyed distributed traces
observability/AuditLogAggregator.js  append-only, immutable audit stream
integration/IntegrationRegistry.js   external systems (OTA/POS/PAYMENT/CHANNEL)
integration/IntegrationAdapterEngine.js  sync/push/pull adapter contract + isolation
integration/WebhookEngine.js    signature verify + idempotency + retry queue
enterprise/PropertyRegistryEngine.js  metadata/branding/timezone/overrides
enterprise/EnterpriseConfigEngine.js  global settings + feature toggles
enterprise/CrossPropertyAnalyticsEngine.js  cross-property aggregation/benchmarking
PlatformLayer.js                facade composing all of the above
middleware/platformMiddleware.js  per-request metrics/log (runs after existing auth)
services/platformSubscriber.js  read-only '*' event consumption -> audit/metrics/analytics
api/platform.controller.js + routes.js   /api/platform/* surface
```

## Security enforcement (APIGateway pipeline)

Every governed request passes, in order: **(1) authentication** (AuthService),
**(2) request context** assembly + tracing id, **(3) RBAC/policy** validation,
**(4) property isolation**, **(5) rate limiting**, **(6) audit logging
injection** — then the handler runs. Outcomes are `401` (auth), `403`
(forbidden + reason), `429` (rate limited), or `200`. Deny-by-default
throughout.

## IAM

- **RBACEngine** — roles ADMIN / FRONT_DESK / HOUSEKEEPING / ACCOUNTING /
  REVENUE_MANAGER / AUDITOR; wildcard permissions (`reservation.*`); role
  inheritance; property-scoped; **deny-by-default**.
- **PolicyEngine** — ALLOW/DENY with a reason; enforces property isolation
  (principal must have access to the target property; ADMIN / `*` is
  platform-wide).
- **AuthService** — opaque session tokens with TTL; login/validate/refresh
  (rotates token)/logout; pluggable user provider.

## Observability

Structured **logs**, **metrics** (counters + latency), **traces** (correlationId
across modules), and a **centralized immutable audit stream** (frozen entries;
no update/delete API). The subscriber consumes the entire domain event stream
read-only and feeds audit + metrics + cross-property analytics.

## Integration hub

- **IntegrationRegistry** — register/enable external systems by type.
- **IntegrationAdapterEngine** — `syncReservations / pushRates / pushAvailability
  / pullBookings` contract + validation + isolation.
- **WebhookEngine** — HMAC **signature verification**, **idempotency keys**
  (dedupe), and a **retry queue** with dead-lettering.

## Multi-property enterprise control

- **PropertyRegistryEngine** — metadata, branding separation, timezone,
  per-property config overrides.
- **EnterpriseConfigEngine** — global settings, security defaults, **feature
  toggles**, integration enablement; property overrides resolve over globals.
- **CrossPropertyAnalyticsEngine** — occupancy/revenue/demand aggregation,
  comparison, benchmarking, top-performer ranking.

## Platform APIs (`/api/platform/*`, additive, runs after the existing auth chain)

`GET /admin/metrics|logs|audit`, `GET /integrations/status`,
`POST /integrations/webhook|sync`, `GET /enterprise/properties|analytics|config`
— guarded by reserved permissions; observability middleware records each
request.

## Constraints honored

- **No modification** of Reservation/Front Desk/Billing/Housekeeping/Night
  Audit/Revenue; event/API-based only; the subscriber never mutates upstream
  state.
- **Strict multi-property isolation** (PolicyEngine + property-scoped audit /
  analytics).
- No schema changes (migrations stay 0001–0044); no AI; CI green; fully
  backward compatible (the platform mounts alongside existing routes and does
  not alter the existing auth pipeline).

## Tests (`test/platform.test.js`) — all green

IAM (login/validate/refresh/logout, RBAC wildcard+inheritance+deny, policy
property isolation) · gateway pipeline (401/403/429/200 + context injection +
rate limiting) · observability (log/metrics/trace + audit immutability) ·
integration (webhook signature/idempotency/retry, adapter contract) ·
enterprise (registry, feature toggle, cross-property analytics) · read-only
event subscriber.

## Outcome

QYRVIA gains a secure identity layer, governed API surface, full observability
across Phases 11–17, external integration capability, and an enterprise
analytics foundation — a production-grade multi-tenant enterprise SaaS platform
on top of the hospitality + revenue core.
