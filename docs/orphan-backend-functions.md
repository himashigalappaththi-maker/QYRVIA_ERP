# Orphan / Backend-Only Functions (Phase 35)

Backend handlers that are **not exposed via any REST route**. Each is classified
as *intentional* (event-driven / internal / scheduled) or *unintended orphan*.
No removals — this is an inventory.

## Commands with no REST route

| Command | Trigger | Classification |
|---|---|---|
| `aggregate.action` | event-store / aggregate framework internal | 🔒 intentional (infrastructure) |
| `reservation.create` | Booking Engine internal orchestration (wraps `pms.reservation.create`) | 🔒 intentional (internal entry; public path is `/api/booking/create`) |
| `pms.allocation.create` | event subscriber (`reservation.created`) | 🔒 intentional (event-driven inventory) |
| `pms.allocation.release` | allocation lifecycle | 🔒 intentional |
| `pms.allocation.release_sweep` | scheduled job (`pms.allocation.release_sweep` handler) | 🔒 intentional (cron sweep) |

**No unintended orphan commands found.** Every other registered command maps to a
route in `routes/pms.js` or `routes/finance.js` (verified against the `call('...')`
references).

## Queries with no REST route
**None.** All registered queries are exposed (`routes/pms.js`, `routes/finance.js`,
`routes/iam.js`). Several are exposed-but-unconsumed by the frontend — those are
*frontend* gaps, tracked in [missing-ui-features.md](./missing-ui-features.md), not
backend orphans.

## Modules/services not surfaced via HTTP (consumed internally)
- **Channel Manager internals** beyond `/api/channel`: persistence stores,
  credential store, mapping management, outbound sync, inbound pipeline, queue
  worker — all DI-wired and event/worker-driven; default-dormant. 🔒 intentional.
- **AI WhatsApp agent / AI confirmation** — default OFF; `/api/ai-confirmation`
  exposes ops endpoints only when enabled. 🔒 intentional.
- **Revenue subscriber / Platform subscriber** — event consumers, no HTTP. 🔒.
- **Observability registry** (Phase 32–34) — exposed via `/api/platform/metrics*`
  for scraping; the rest is process-internal. 🔒.

## Conclusion
All backend-only handlers are intentional (event-driven, scheduled, internal
orchestration, or feature-flagged). There are **no accidentally unreachable
backend write paths**.
