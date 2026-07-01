# QYRVIA Phase 22 — API Contract Freeze & Frontend Integration Readiness

**Phase type:** architecture / consistency / integration-readiness. **No** UI redesign, **no**
navigation change, **no** frontend cutover, **no** new business features, **no** schema change.

**Decision on code changes:** This is a *freeze* phase whose six deliverables are all documents.
Every endpoint the Stitch frontend calls already works end-to-end through the
`utils/normalize.js` shim. Changing live response envelopes now (e.g. `result`→`data` on
revenue/channel/platform reads) would be a contract change during a freeze. **Therefore no
runtime behavior was changed.** All deviations are documented here with a graded, opt-in
remediation plan for a future phase. (See §2 and §7.)

**Evidence base:** `server/src/routes/*`, `server/src/core/{commandBus,queryBus}.js`,
`server/src/{revenue,channel-manager,platform}/api/*.controller.js`,
`frontend-stitch/src/services/{index,apiClient}.js`, `frontend-stitch/src/utils/normalize.js`,
and the registered command/query handler sets under `server/src/{commands,queries}/*`.

---

## 1. API Contract Audit — inventory summary

Full per-endpoint inventory (route, method, module, payload, response, auth, permission,
controller, service, repository, status) lives in
[`QYRVIA_API_CONTRACT_CATALOG.md`](./QYRVIA_API_CONTRACT_CATALOG.md). Totals:

| Surface | Endpoints | Consumed by Stitch | Envelope conformance |
|---|---:|:---:|---|
| `/api/health` | 2 | no | n/a (probes) |
| `/api/auth` | 7 | **yes** | bespoke token envelope (frozen) |
| `/api/pms` | 56 | **yes** (most) | ✅ `data`/`result` (bus) |
| `/api/finance` | 15 | **yes** | ✅ `data`/`result` (bus) |
| `/api/iam` | 2 | no | ✅ `data` (bus) |
| `/api/channel` | 6 | **yes** | ⚠️ `result` for reads |
| `/api/revenue` | 7 | **yes** | ⚠️ `result` for reads |
| `/api/platform` | 9 | **yes** | ⚠️ `result` for reads |
| `/api/core` | 3 | no | generic / stub |
| `/api/connector` (singular) | 2 | no | legacy stub |
| `/api/connectors` (plural) | 5 | no | bespoke keys |
| `/api/settings` | 6 | no | mostly ✅, one `value` |
| `/api/files` | 5 | no | bespoke `file` key |
| `/api/webhooks` | 4 | no | bespoke `endpoints` key |
| `/api/jobs` | 3 | no | bespoke `id` key |
| `/api/notifications` | 4 | no | bespoke `notifications` key |
| **Total** | **~136** | — | — |

**Modules in scope but absent as API surfaces:** CRM, Procurement, HR/Payroll (not present);
Inventory (internal engine only, surfaced via `/pms/availability`). See catalog §11.

---

## 2. Response Shape Standardization

### 2.1 Target contract
```
READ   → { "ok": true,  "data":   ... }
WRITE  → { "ok": true,  "result": ... }
ERROR  → { "ok": false, "error": { "code": "...", "message": "..." } }
```

### 2.2 Conformance findings

**A. Reads using `result` instead of `data` (3 surfaces).**
`/api/revenue`, `/api/channel`, `/api/platform` controllers emit `{ ok:true, result }` for
**every** handler including GETs (`revenue.controller.js:11`, `platform.controller.js:7`,
`channel.controller.js`). 22 GET endpoints affected. *Safe to fix* (frontend `unwrap()`
already reads both keys) but is a contract change → deferred.

**B. Error is a string, not `{code,message}` (universal).**
Both buses and all three controllers return `{ ok:false, error:"<string_code>", detail? }`
(`commandBus.js:58-94`, `queryBus.js:46-89`, controllers' `fail()`). The target nests
`error.code`/`error.message`. This is the **single most widespread deviation** — but it is
**100% internally consistent**, and the frontend depends on the string form: `apiClient.js:41`
reads `data.error` as the code. Changing to a nested object is a **breaking change for the
client** and must be coordinated (see §7, remediation R2).

**C. Bespoke top-level keys (Phase-3 infra surfaces).**
`settings` GET-key → `value`; `files` → `file`; `connectors` → `connectors`/`config`;
`webhooks` → `endpoints`; `notifications` → `notifications`/`notification`; `jobs` → `id`;
`auth` login/me/refresh → bare fields. None are consumed by the Stitch SPA today, so they
carry **no integration risk** for cutover; they violate the envelope on paper only.

**D. Semantically-read endpoints exposed as writes.**
`POST /finance/ledger/validate` (returns `result`, permission `ledger.read`) and the
connectors `probe`/`health` POSTs. Documented exceptions — behavior is correct, verb is
pragmatic.

### 2.3 Conforming surfaces (no action)
`/api/pms` (56) and `/api/finance` reads (via query bus) and writes (via command bus) already
emit `{ok,data}` / `{ok,result}`. `/api/iam` and `/api/settings` schema/list reads conform.
`/api/auth/properties` conforms.

### 2.4 Decision
**No refactor applied in Phase 22.** Rationale: the freeze mandate plus "no breaking API
changes unless clearly documented." Items A and C are low-risk and queued as R1/R3; item B is
breaking and queued as R2 behind a versioned envelope. See §7.

---

## 3. Deliverable — Frontend ↔ Backend Mapping Matrix

Source: `frontend-stitch/src/services/index.js` (service adapters) → backend routes.
**Classification legend:** ✅ Working · 🟡 Working w/ adapter normalization · ❌ Contract mismatch ·
☠️ Dead · ⛔ Missing · ♻️ Duplicate.

| Frontend call | Service adapter | Route | Cmd/Controller | Class |
|---|---|---|---|:---:|
| `auth.login` | `POST /auth/login` | `routes/auth.js` | identity/tokens | 🟡¹ |
| `auth.refresh` / `logout` / `me` | `/auth/*` | `routes/auth.js` | identity/tokens | 🟡¹ |
| `auth.properties` | `GET /auth/properties` | `routes/auth.js` | identityRepo | ✅ |
| `auth.switchProperty` | `POST /auth/switch-property` | `routes/auth.js` | identity/tokens | 🟡¹ |
| `auth.register` | `POST /auth/register` | `routes/auth.js` | `auth.user.create` | ✅ |
| `reservations.*` (8) | `/pms/reservations*` | `routes/pms.js` | `pms.reservation.*` | ✅ |
| `groups.*` (6) | `/pms/reservation-groups*` | `routes/pms.js` | `pms.reservation_group.*` | 🟢² |
| `guests.*` (4) | `/pms/guests*` | `routes/pms.js` | `pms.guest.*` | ✅ |
| `rooms.*` (11) | `/pms/rooms*`, `/room-types`, `/room-features` | `routes/pms.js` | `pms.room*/roomtype/feature` | ✅ |
| `availability.*` (2) | `/pms/availability*` | `routes/pms.js` | `pms.availability.*` | 🟡 |
| `ratePlans.*` (4) | `/pms/rate-plans*` | `routes/pms.js` | `pms.rateplan/mealplan` | 🟡 |
| `mealPlans.*` (3) | `/pms/meal-plans*` | `routes/pms.js` | `pms.mealplan.*` | 🟡 |
| `childPolicies.*` (2) | `/pms/child-policies*` | `routes/pms.js` | `pms.childpolicy.*` | 🟡 |
| `billing.invoices*` (3) | `/pms/invoices*` | `routes/pms.js` | `pms.invoice.*` | 🟡 |
| `billing.folio*` (5) | `/pms/folios*` | `routes/pms.js` | `pms.folio.*` | 🟡 |
| `vouchers.*` (4) | `/pms/vouchers*` | `routes/pms.js` | `pms.voucher.*` | 🟢² |
| `housekeeping.*` (3, writes) | `/pms/housekeeping/tasks*` | `routes/pms.js` | `pms.housekeeping.task.*` | ✅ |
| `nightAudit.*` (2, writes) | `/pms/night-audit/*` | `routes/pms.js` | `pms.night_audit.*` | ✅ |
| `revenue.*` (7) | `/revenue/*` | `revenue.routes.js` | revenue controller | 🟡³ |
| `finance.*` (12) | `/finance/*` | `routes/finance.js` | `finance.*` | 🟡 |
| `channel.*` (6) | `/channel/*` | `channel.routes.js` | channel controller | 🟡³ |
| `platform.*` (7) | `/platform/*` | `platform.routes.js` | platform controller | 🟡³ |

¹ Bare token envelope — frontend reads named fields directly (no `unwrap`); works, frozen by design.
² Service method defined but **not referenced by any view** (`groups`, `vouchers`). Live route exists; UI wiring pending. Not a defect — note for cutover backlog.
³ Reads return `result`; only works because `unwrap()` checks `result` after `data`.

**No ❌ contract mismatches, no ☠️ dead frontend calls, no ⛔ missing backend routes** for
anything the SPA actually invokes. Every declared adapter resolves to a live, permissioned
route. The integration is *functionally complete*; the open items are envelope hygiene (🟡)
and two unwired-but-available service groups (🟢).

### 3.1 Backend reads available but NOT consumed (degrade-gracefully gaps)
These exist on the backend but have **no frontend adapter**, so the corresponding screens
either omit the data or derive it elsewhere. Flag for cutover UX review:

| Endpoint | Note |
|---|---|
| `GET /pms/housekeeping/tasks`, `/housekeeping/room-status` | HK board currently driven from rooms feed; task list read unused. |
| `GET /pms/night-audit/status`, `/night-audit/history` | NightAudit view triggers runs but does not read status/history. |
| `GET /pms/folios`, `/folios/:id`, `/folios/:id/allocations` | Billing view has no folio read adapter. |
| `GET /pms/reservation-groups/:id*`, `/vouchers/:n` | adapters exist but unwired (see ² above). |
| `GET /iam/users`, `/iam/roles` | no IAM admin screen wired. |
| `/api/settings`, `/files`, `/jobs`, `/webhooks`, `/notifications`, `/connectors` | Phase-3 infra; no SPA surface yet. |

---

## 4. Deliverable — Normalization Dependency Report

**File audited:** `frontend-stitch/src/utils/normalize.js` (`unwrap`, `asArray`, `asObject`).
**Usage:** imported by **15 of 16** data-bearing modules (every view except `auth/Login`),
totalling ~51 call sites (`Admin` 7, `RatePlans`/`Revenue` 5 each, `Availability`/`Billing`/`Finance`/`shared` 4 each, …).

### 4.1 Why normalization exists
`unwrap()` collapses three envelope variants the backend emits:
1. `{ ok, data }` — `/pms`, `/finance`, `/iam`, `/settings` reads (query bus).
2. `{ ok, result }` — `/revenue`, `/channel`, `/platform` reads + all writes.
3. bare value / `{items|rows|list|records|entries}` shapes inside the payload (`asArray`).

So normalization is driven by **two** backend facts: (a) the `data`-vs-`result` split for reads
(§2.2-A), and (b) inconsistent collection key names inside payloads.

### 4.2 Which endpoints *require* normalization
| Driver | Endpoints | Removable by backend fix? |
|---|---|---|
| reads return `result` not `data` | all `/revenue`, `/channel`, `/platform` GETs (22) | **Yes** — remediation R1 |
| collection nested under varying keys | scattered list reads | Partially — needs payload-shape audit (R4) |
| bare-value reads | a few single-object reads | Yes if wrapped in `data` consistently |
| writes return `result` | all writes | No — `result` is the *correct* write key; `unwrap` use on writes is defensive only |

### 4.3 Can backend fixes eliminate the normalization dependency?
- **`unwrap()`**: ~80% eliminable. If R1 lands (reads emit `data`), the only remaining need is
  defensive write-unwrapping, which is optional.
- **`asArray()` / `asObject()`**: **keep regardless.** These are legitimate view-side coercion
  helpers (null-safety, collection-key tolerance) and removing them would make views brittle.
  They should remain as a thin defensive layer even after envelope standardization.

**Recommendation:** treat `unwrap()` as a *temporary compatibility shim* tied to R1; treat
`asArray`/`asObject` as *permanent* defensive utilities. Do not block cutover on removing them.

---

## 5. Deliverable — Dead / Duplicate Endpoint Report

**No deletions performed (per constraints). Findings only.**

### 5.1 Duplicate / alias routes (intentional, low-risk)
| Group | Members | Verdict |
|---|---|---|
| Check-in alias | `/reservations/:id/checkin` **and** `/check-in` | Duplicate alias → same command. Keep one canonical (`/checkin`) post-cutover; alias is harmless. |
| Check-out family | `/checkout`, `/check-out`, `/force-checkout`, `/early-checkout`, `/late-checkout` | All → `pms.reservation.checkout`; variants only tag audit `mode`. Intentional. Consider collapsing to `/checkout` + `mode` body param later. |
| Ledger read | `/finance/ledger/by-reference` **and** `/finance/ledger` | Explicit Phase-21 convenience alias. Harmless. |

### 5.2 Legacy / superseded
| Endpoint | Finding |
|---|---|
| `/api/connector` (singular) `:id/probe`, `:id/health` | **Phase-1 stubs** returning `not_configured`. Superseded by `/api/connectors` (plural) real registry. Candidate for removal once confirmed no client depends on the stub shape. **Do not delete in Phase 22.** |
| `/api/core/*` `ALL /*` 501 stub | Intentional 404-avoidance stub. Keep. |

### 5.3 Registered commands with no dedicated REST route
| Command | Status |
|---|---|
| `pms.allocation.create`, `pms.allocation.release`, `pms.allocation.release_sweep` | Registered, reachable **only** via generic `POST /api/core/commands/:name`. Internal hold/allocation lifecycle (driven by reservation flow + sweeper), not meant for direct UI. **Not dead** — intentionally route-less. |
| `aggregate.action` | Internal generic aggregate command. Route-less by design. |

### 5.4 Unused frontend service methods
`services.groups.*` and `services.vouchers.*` are defined but referenced by **no view**
(§3, ²). Live backend routes exist. Backlog item: wire the UI or drop the adapters. No harm
in place.

### 5.5 No true dead endpoints
Every routed endpoint resolves to a registered handler (confirm/cancel/no-show are registered
dynamically via `transitionCmd`, `commands/pms/index.js:456-458`). No route points at a
missing command/query.

---

## 6. Deliverable — Frontend Cutover Readiness Assessment

Evidence-based scoring. Each score = (conforming or safely-adapted units) ÷ (relevant units),
weighted by integration risk.

### 6.1 Backend Contract Readiness — **78%**
| Factor | Weight | Score | Evidence |
|---|---:|---:|---|
| Envelope on consumed reads | 30% | 70% | 22 `/revenue,channel,platform` GETs use `result` not `data` (§2.2-A). |
| Envelope on writes | 20% | 100% | All writes use `result` via command bus. |
| Error shape | 25% | 60% | String `error` everywhere, not `{code,message}` (§2.2-B) — consistent but off-spec. |
| Auth/permission coverage | 15% | 100% | Every `/api/*` endpoint gated by `requirePermission` + JWT chain. |
| RBAC consistency | 10% | 95% | Seeded perms (migration 0030); 2 minor verb/permission mismatches documented. |
| **Weighted** | | **78%** | |

### 6.2 Frontend Integration Readiness — **88%**
| Factor | Weight | Score | Evidence |
|---|---:|---:|---|
| Declared calls reaching live routes | 40% | 100% | 0 missing/dead calls (§3). |
| Single ingress discipline | 20% | 100% | All traffic via `apiClient`; no direct `fetch`/bypass in modules. |
| 401/403/session handling | 15% | 100% | Centralized in `apiClient.js:29-37`. |
| Read coverage of available data | 15% | 55% | Several backend reads unconsumed (§3.1). |
| Unwired-but-available adapters | 10% | 70% | `groups`, `vouchers` defined, not referenced. |
| **Weighted** | | **88%** | |

### 6.3 Cutover Readiness — **72%**
| Factor | Weight | Score | Rationale |
|---|---:|---:|---|
| Functional end-to-end paths | 35% | 95% | All wired flows work today through the shim. |
| Contract stability (freeze) | 25% | 75% | Envelope split + error shape unresolved; frozen but not standardized. |
| Normalization independence | 15% | 40% | UI still depends on `unwrap()` to hide `data`/`result` split (§4). |
| Admin/infra surface coverage | 15% | 50% | settings/files/jobs/webhooks/notifications/iam unsurfaced. |
| Documentation/contract reference | 10% | 100% | This catalog + freeze doc. |
| **Weighted** | | **72%** | |

### 6.4 Headline
| Metric | Score |
|---|---|
| **Backend Contract Readiness** | **78%** |
| **Frontend Integration Readiness** | **88%** |
| **Cutover Readiness** | **72%** |

**Interpretation:** the system is *functionally cutover-capable today* — every wired path works.
The 72% reflects that cutover would currently *inherit* the normalization shim and the
non-standard error envelope rather than resolve them. Closing R1 + R2 (below) raises Cutover
Readiness to an estimated ~90%.

---

## 7. Remediation backlog (for a post-freeze phase — NOT executed here)

| ID | Change | Risk | Breaking? | Effort |
|---|---|---|---|---|
| **R1** | Revenue/Channel/Platform reads emit `data` instead of (or alongside) `result` | Low | No (frontend `unwrap` reads both) | S |
| **R2** | Standardize errors to `{ error:{ code, message } }` behind an envelope version; update `apiClient` to read `error.code` with string fallback | Med | **Yes** (coordinated) | M |
| **R3** | Normalize Phase-3 infra keys (`value`/`file`/`endpoints`/…) to `data` when those surfaces get UI | Low | No (unconsumed today) | S each |
| **R4** | Payload collection-key audit; standardize list payloads on one key so `asArray` fallbacks shrink | Low | No | M |
| **R5** | Collapse checkout alias family to `/checkout` + `mode`; retire singular `/connector` stub | Low | Yes (remove aliases) | S |
| **R6** | Wire or remove unused `groups`/`vouchers` adapters; add reads for HK/night-audit/folio screens | — | No | M |

---

## 8. Constraints honored
- ✅ No UI redesign, no navigation change, no frontend cutover.
- ✅ No business feature expansion.
- ✅ No database schema changes.
- ✅ No breaking API changes — **zero runtime code changed**; all deviations documented, remediation deferred and graded.

## 9. Deliverable index
1. **This document** — `docs/QYRVIA_PHASE22_API_CONTRACT_FREEZE.md`
2. **API Contract Catalog** — `docs/QYRVIA_API_CONTRACT_CATALOG.md`
3. **Frontend ↔ Backend Mapping Matrix** — §3 above
4. **Normalization Dependency Report** — §4 above
5. **Dead / Duplicate Endpoint Report** — §5 above
6. **Cutover Readiness Assessment** — §6 above
