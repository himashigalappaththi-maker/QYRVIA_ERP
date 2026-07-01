# Missing UI Features (Phase 35)

Backend capabilities that exist and are reachable via API but have **no usable
frontend control today**. Ordered by operational priority. None are blockers for
the backend; all are UI build-out items.

## High priority (core admin / daily ops)

1. **IAM — users & roles** (`/api/iam/users`, `/api/iam/roles`)
   No screen. Operators cannot view users/roles in the new shell. (Backend
   read-only today; create flows via `auth.user.create` command/`/auth/register`.)
2. **Settings management** (`/api/settings/*`)
   Typed settings catalog (schema + read/write/delete) has no UI. Property/tenant
   configuration is unreachable.
3. **Reservation edit & room-move** (`PUT /pms/reservations/:id`, `/room-move`)
   No edit form; `services.reservations` lacks `update`/`roomMove`. In-house
   reassignment and pre-stay edits not exposed.
4. **Folio browser** (`GET /pms/folios`, `GET /pms/folios/:id`)
   Billing posts charges/payments but cannot list/open a folio directly; no
   `services.billing.folios/folioById`.
5. **Vouchers** (`/pms/vouchers*`) — service methods exist, **no view**.
6. **Reservation groups** (`/pms/reservation-groups*`) — service methods exist, **no view**.

## Medium priority (setup / catalog)

7. **Room/RoomType/Feature creation** (`POST /pms/rooms`, `/room-types`, `/room-features`, attach)
   `services.rooms.create*` defined but no creation forms.
8. **Rate-plan creation & meal-plan attach** (`POST /pms/rate-plans`, `/rate-plans/:id/meal-plan`).
9. **Meal-plan / child-policy creation** (`POST /pms/meal-plans`, `/child-policies`).
10. **Revenue-map management** (`/finance/revenue-map*`) — posting-map config, no UI.
11. **Manual ledger ops** (`/finance/ledger/post|validate|revert`) — service defined, no UI (likely admin-only).
12. **Cost-center edit** (`PUT /finance/cost-centers/:id`) — create/disable shown, edit absent.

## Lower priority (background ops / integrations)

13. **Scheduler / jobs** (`/api/jobs`) — schedule/cancel/run, no UI.
14. **Notifications** (`/api/notifications`) — send/list/detail, no UI.
15. **Webhooks** (`/api/webhooks`) — endpoint registration/deliveries, no UI.
16. **Files** (`/api/files`) — upload/download/delete, no UI.
17. **Connectors** (`/api/connector(s)`) — config/probe/health, no UI (Channel/Control covers OTA sync only).

## Dedicated read endpoints bypassed (data shown via a different source)
- FrontDesk: `/pms/frontdesk/arrivals|departures|inhouse` unused — view derives lists from `reservations.list`.
- Housekeeping: `/pms/housekeeping/tasks|room-status` unused — board derives from `rooms.list`.
- Night Audit: `/pms/night-audit/status|history` unused — view shows run/schedule only.

> These three are **functional but suboptimal**: the purpose-built reads return
> richer/cheaper payloads than the client-side derivation. Recommend wiring them
> during the Stitch migration.
