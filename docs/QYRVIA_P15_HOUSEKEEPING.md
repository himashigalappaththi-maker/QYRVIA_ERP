# QYRVIA Phase 15 — Housekeeping Optimization Engine

> Converts room/stay events into optimized housekeeping workflows. Additive and
> self-contained; JS / CommonJS; consumes Room (11), Reservation (12), Front
> Desk (13), Billing (14) events **read-only** and never modifies those
> engines. **No LLMs / no mock AI — deterministic scoring, clustering, and
> workload balancing only.** Full audit trail + multi-property isolation.

## Modules (`server/src/housekeeping/`)

```
models/HousekeepingModels.js        Task / room HK lifecycle / enums / base minutes
repository/housekeepingRepo.memory.js  tasks + room status + audit log (property-scoped)
core/PriorityEngine.js              deterministic 0-100 priority score
core/ZoneOptimizationEngine.js      cluster by floor/building/wing/zone (min walking)
core/WorkloadBalancer.js            balance minutes vs capacity (no overload)
core/ReadinessPredictionEngine.js   deterministic estimate + confidence + ready time
core/HousekeepingTaskEngine.js      task lifecycle + room status flow + audit
core/HousekeepingEngine.js          facade: optimizeAssignments + dashboards
services/housekeepingSubscriber.js  event -> task wiring
```

## Room status lifecycle

```
OCCUPIED -> DIRTY -> CLEANING -> CLEAN -> INSPECTED -> READY
```

Forward transitions are guarded; **rollback is supported with audit logging**
(a failed inspection sends the room back to CLEANING). Phase 15 owns this
status in its own store — it never writes to the Phase 11 Room engine.

## Engines (deterministic)

- **PriorityEngine** — fixed-weight 0-100 score from: arriving guest today
  (+30), early check-in risk (+20), VIP (+25), suite (+10), checkout completed
  (+10), maintenance dependency (+5), occupancy pressure (×20).
- **ZoneOptimizationEngine** — clusters tasks by zone key and orders
  highest-priority-first within a zone to minimize walking.
- **WorkloadBalancer** — assigns highest-priority tasks to the least-loaded
  eligible (zone-preferred) employee within capacity; overflow is returned as
  `unassigned` (staff are never overloaded).
- **ReadinessPredictionEngine** — estimate = historical average when available
  (confidence scales with sample size), else baseline × room-type factor
  (confidence 0.5); `predictedReadyTime = now + estimate`.

## Task engine

`createTask / assignTask / startTask / completeTask / inspectRoom / markReady`.
Task types: Checkout Cleaning, Stayover Cleaning, Deep Cleaning, Inspection,
Maintenance Follow-up, VIP Preparation, Transfer Cleaning. Priority is scored at
creation; cleaning tasks drive the room status flow. Every operation appends an
audit record (`propertyId`, `userId`, `timestamp`, action, from/to status).

## Event integration (consume only)

| Event | Task created |
|---|---|
| `stay.ended` | Checkout Cleaning |
| `stay.room_moved` / `room.moved` | Transfer Cleaning (vacated room) |
| `maintenance.completed` | Inspection |
| `vip.arrival.flagged` | VIP Preparation (high priority) |

Upstream systems are never modified.

## Dashboards

- **Executive** — rooms ready, rooms dirty, cleaning backlog, average turnaround.
- **Supervisor** — active tasks, overdue tasks, staff workload, readiness
  forecast.

## Tests (`test/housekeeping.test.js`) — all green

Priority scoring · zone clustering · workload balancing (with overload
prevention) · readiness prediction · full room lifecycle + audit · failed-
inspection rollback · optimizeAssignments · dashboards · multi-property
isolation · event subscriber integration.

## Success criteria — met

A checkout (`stay.ended`) automatically generates housekeeping work, scores
optimal priority, balances workload across staff by zone, predicts readiness,
and transitions the room DIRTY → READY — with complete auditability and strict
multi-property isolation. Deterministic throughout; no AI/LLM. CI green.
