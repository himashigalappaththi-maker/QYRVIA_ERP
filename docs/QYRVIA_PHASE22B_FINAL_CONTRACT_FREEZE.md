# QYRVIA Phase 22B — Final Contract Freeze Validation (Pre-Cutover Gate)

**Phase type:** validation + reconciliation only. **No** UI change, **no** new APIs, **no**
business-logic expansion, **no** schema change, **no** frontend behavior refactor.
**Zero runtime code was modified in this phase** — it is a re-verification pass that produces
evidence and a cutover decision.

**Gate position:** final validation before Phase 23 (frontend integration stabilization),
Phase 24 (UI modernization), and cutover planning.

**Evidence base (re-read live, not inherited from Phase 22):**
- `server/src/routes/{pms,finance,iam,api}.js`, `server/src/core/{commandBus,queryBus}.js`
- `server/src/{revenue,channel-manager,platform}/api/*.controller.js`
- `frontend-stitch/src/services/{index,apiClient}.js`, `frontend-stitch/src/utils/normalize.js`
- All view modules under `frontend-stitch/src/modules/*`
- Test suites: `server/test/**` (458 tests), `frontend-stitch/test/**` (27 tests)

**Verification commands run for this report:**
| Check | Result |
|---|---|
| `server` → `npm test` | **455 pass / 0 fail / 3 skipped** (458 total) |
| `frontend-stitch` → `npm test` | **27 pass / 0 fail / 0 skipped** |
| Controller envelope grep (rev/chan/plat) | reads still emit `{ ok, result }` (unchanged) |
| `unwrap(` direct call sites (excl. definition) | **0** |
| `asArray(` / `asObject(` call sites | **32 / 18** across 16 files |
| `services.X.Y` view refs vs defined adapters | **62 referenced, 0 dangling** |

---

## 1. Global API Contract Audit — Final Pass

Per-endpoint inventory is frozen in [`QYRVIA_API_CONTRACT_CATALOG.md`](./QYRVIA_API_CONTRACT_CATALOG.md).
This pass re-confirms the **as-implemented** envelopes against the target contract:

```
READ   → { ok: true,  data: ... }
WRITE  → { ok: true,  result: ... }
ERROR  → { ok: false, error: { code, message } }   (target)
```

### 1.1 Per-module conformance (re-validated)

| Module | Surface | Read envelope | Write envelope | Error envelope | Verdict |
|---|---|---|---|---|---|
| Auth | `/api/auth` | bare token fields + `data` (`/properties`) | `{ok,result}` (`/register`) | string | Frozen-by-design (token exchange) |
| PMS | `/api/pms` | `{ok,data}` (query bus) | `{ok,result}` (command bus) | string | ✅ Conforms (data/result) |
| Front Desk | `/api/pms/frontdesk/*` | `{ok,data}` | — | string | ✅ Conforms |
| Billing/Folios | `/api/pms/folios,invoices,vouchers` | `{ok,data}` | `{ok,result}` | string | ✅ Conforms |
| Housekeeping | `/api/pms/housekeeping/*` | `{ok,data}` | `{ok,result}` | string | ✅ Conforms |
| Night Audit | `/api/pms/night-audit/*` | `{ok,data}` | `{ok,result}` | string | ✅ Conforms |
| Finance | `/api/finance` | `{ok,data}` | `{ok,result}` | string | ✅ Conforms |
| IAM | `/api/iam` | `{ok,data}` | (none — read-only) | string | ✅ Conforms |
| Revenue | `/api/revenue` | **`{ok,result}`** | `{ok,result}` | string | ⚠️ reads use `result` |
| Channel | `/api/channel` | **`{ok,result}`** | `{ok,result}` | string | ⚠️ read (`/status`) uses `result` |
| Platform | `/api/platform` | **`{ok,result}`** | `{ok,result}` | string | ⚠️ reads use `result` |
| Notifications | `/api/notifications` | bespoke `notifications`/`notification` | `{ok,...}` | string | ⚠️ bespoke key (not consumed) |
| Connectors | `/api/connectors` | bespoke `connectors`/`config` | `{ok,...}` | string | ⚠️ bespoke key (not consumed) |
| Settings | `/api/settings` | `{ok,data}` + one `value` | `{ok,...}` | string | ⚠️ one read key (not consumed) |
| Files / Jobs / Webhooks | `/api/{files,jobs,webhooks}` | bespoke `file`/`id`/`endpoints` | `{ok,...}` | string | ⚠️ bespoke keys (not consumed) |

### 1.2 Read-envelope deviation — exact count

Controllers `revenue.controller.js:11`, `platform.controller.js:7`, and
`channel.controller.js:23-65` define `ok(res, req, result) → res.json({ ok:true, result })`
and use it for **every** handler. GET endpoints affected:

| Module | GET endpoints emitting `result` | Source |
|---|---:|---|
| Revenue | 5 (`/rate`, `/rate-grid`, `/forecast`, `/kpis`, `/dashboard`) | `revenue.controller.js:11` |
| Channel | 1 (`/status`) | `channel.controller.js:65` |
| Platform | 7 (`/admin/metrics,logs,audit`, `/integrations/status`, `/enterprise/properties,analytics,config`) | `platform.controller.js:7` |
| **Total** | **13** | |

All 13 are **read** operations returning the write key `result`. This is the only systematic
read-envelope non-conformance on the SPA-consumed surface.

### 1.3 Error-envelope deviation — universal, frozen

Every bus and controller returns `{ ok:false, error:"<string_code>", detail? }`
(`commandBus.js`, `queryBus.js`, the three controllers' `fail()`). The target nests
`error.code`/`error.message`. The frontend **depends on the string form**:
`apiClient.js:43` reads `(data && data.error)` as the error code. Migrating to a nested object
is therefore a **breaking, coordinated change** (see §5, R2) — deliberately frozen here.

**Finding:** the string-error shape is off the documented target but **100% internally
consistent** across all 15 surfaces. There is no envelope *drift*; there is a single
intentional standardization debt.

---

## 2. Legacy Contract Deviation Report *(Deliverable 4)*

Classification of every remaining deviation from the target envelope.

| # | Endpoint(s) | Module | Deviation type | Consumed by SPA? | Severity |
|---|---|---|---|:---:|:---:|
| L1 | 13 GET reads (see §1.2) | Revenue / Channel / Platform | `{ok,result}` used for READ | **yes** | **MEDIUM** |
| L2 | All error responses (every module) | All | string `error`, not `{code,message}` | **yes** | **MEDIUM** |
| L3 | `GET /settings/:category/:key` | Settings | top-level `value` key | no | LOW |
| L4 | `GET /files/:id`, `POST /files` | Files | top-level `file` key | no | LOW |
| L5 | `GET /webhooks` | Webhooks | top-level `endpoints` key | no | LOW |
| L6 | `GET /notifications`, `/:id` | Notifications | top-level `notifications`/`notification` | no | LOW |
| L7 | `POST /jobs` | Jobs | top-level `id` key | no | LOW |
| L8 | `GET /connectors`, `/:code/config` | Connectors | top-level `connectors`/`config` | no | LOW |
| L9 | `POST /finance/ledger/validate` | Finance | read semantics via POST → `result` | yes (write-path) | LOW (documented exception) |
| L10 | `/api/connector` (singular) probe/health | Connectors (legacy) | Phase-1 stub shape | no | LOW (supersede candidate) |

**Severity rationale:** L1/L2 are MEDIUM because they touch the consumed surface and shape the
post-cutover cleanup, **not** because they break anything today — both are fully absorbed by the
frozen frontend layer. L3–L10 are LOW: they violate the envelope on paper only and have **no SPA
consumer**, so they carry zero cutover integration risk.

**No HIGH-severity deviations exist.** No hybrid/ambiguous envelope was found — within each class
(query bus / command bus / each controller) the shape is uniform.

---

## 3. Normalization Dependency Audit — Final

**File:** `frontend-stitch/src/utils/normalize.js` — exports `unwrap`, `asArray`, `asObject`.

### 3.1 Live usage (measured)

| Helper | Direct call sites (excl. definition) | Classification |
|---|---:|---|
| `unwrap()` | **0** | **Eliminated as a direct dependency** — now an internal helper only, called by `asArray`/`asObject`. |
| `asArray()` | 32 | **Permanent defensive utility** — null-safety + collection-key tolerance. |
| `asObject()` | 18 | **Permanent defensive utility** — object coercion / null-safety. |

Imported by 16 modules (every data-bearing view + `PropertySwitcher`, `frontdesk/shared`).
Per-file spread: Admin 7, RatePlans 5, Revenue 5, Availability/Billing/Finance/frontdesk-shared 4,
Dashboard/Rooms 3, others 1–2.

### 3.2 Classification against cutover

| Dependency | Status | Why |
|---|---|---|
| `unwrap()` direct usage | **Eliminated** | 0 call sites. The data/result split is no longer visible to view code; it is hidden one level down inside `asArray`/`asObject`. |
| `asArray()` / `asObject()` | **Required — permanent (not temporary)** | They are legitimate view-side coercion (null-safety, varying collection keys). They are **not** a backend-inconsistency workaround and should remain after cutover. Removing them would make views brittle. |
| Residual `{result}`-read tolerance inside `unwrap()` | **Temporary** | The `result`-branch in `unwrap()` (`normalize.js:12`) exists solely to absorb L1. Removable only if/when R1 lands. Harmless to keep. |

### 3.3 Conclusion

Frontend dependency on backend inconsistency is **minimal and well-isolated**: exactly one
code path (`normalize.js:12`, the `result` fallback) is a compatibility shim for L1; everything
else (`asArray`/`asObject`) is legitimate defensive coercion that should survive cutover. The
Phase 22 goal of "minimize unwrap dependency" is **met** — direct `unwrap()` usage is zero.

---

## 4. Frontend Adapter Contract Validation

**Mapping:** Frontend service (`services/index.js`) → API endpoint → response shape.
**Cross-checked** by two live tests: *"services map to existing backend routes (method + path)"*
and *"every service path targets a known mounted prefix"* (both passing).

### 4.1 Reference integrity (measured)

- **62** distinct `services.X.Y` references across all views.
- **62 / 62** resolve to a defined adapter in `services/index.js`. **0 dangling references.**
- **Every** defined adapter path maps to a live, permissioned route in the catalog. **0 missing endpoints.**
- **0** direct `fetch`/bypass in any module — single ingress via `apiClient` is intact.

### 4.2 Flags

| Flag type | Found | Detail |
|---|:---:|---|
| Mismatch (call → wrong/absent route) | **0** | All adapters target live routes (test-enforced). |
| Hidden normalization dependency | **1 path** | L1 `result`-reads (revenue/channel/platform) resolve only via `asArray`/`asObject`→`unwrap`. Isolated, documented. |
| Silent fallback dependency | **1** | `FrontDesk.view.js:61` derives arrivals/departures/in-house client-side from `reservations.list({})` instead of the dedicated `/pms/frontdesk/*` reads. Functional; the backend reads remain unconsumed. |
| Missing endpoint | **0** | — |
| Duplicate mapping | **0 in frontend** | Backend alias families exist (check-in/out, ledger) but each frontend adapter binds one canonical path. |

### 4.3 Backend reads available but NOT consumed (degrade-gracefully gaps)

These exist and are permissioned but have no frontend adapter — flag for Phase 23 UX review,
**not** cutover blockers:

| Endpoint | Note |
|---|---|
| `GET /pms/frontdesk/{arrivals,departures,inhouse}` | FrontDesk derives these client-side (§4.2). |
| `GET /pms/folios`, `/folios/:id` | Billing view has folio writes but no folio-list read adapter. |
| `GET /pms/housekeeping/{tasks,room-status}` | HK board driven from rooms feed. |
| `GET /pms/night-audit/{status,history}` | NightAudit view triggers runs; status/history read unused. |
| `GET /iam/users`, `/roles` | No IAM admin screen wired. |
| `services.groups.*`, `services.vouchers.*` | Adapters defined, referenced by no view (backlog). |

---

## 5. Remediation backlog (post-freeze — NOT executed here)

Carried forward from Phase 22, re-confirmed against current code:

| ID | Change | Breaking? | Severity addressed | Effort |
|---|---|:---:|---|---|
| **R1** | Revenue/Channel/Platform reads emit `data` (alongside or instead of `result`) | No (`asArray`/`unwrap` read both) | L1 | S |
| **R2** | Standardize errors to `{ error:{ code, message } }` behind an envelope version; update `apiClient.js:43` to read `error.code` with string fallback | **Yes (coordinated)** | L2 | M |
| **R3** | Normalize Phase-3 infra keys (`value`/`file`/`endpoints`/…) when those surfaces get UI | No (unconsumed) | L3–L8 | S each |
| **R4** | Wire or retire `groups`/`vouchers` adapters; add folio/HK/night-audit/IAM read adapters | No | §4.3 | M |
| **R5** | Retire legacy singular `/api/connector` stub; collapse checkout alias family | Yes (remove aliases) | L10 | S |

---

## 6. Frontend Dependency Cleanup Plan *(Deliverable 5)*

Only one genuine compatibility dependency exists; the rest is permanent defensive code.

| Step | Action | Trigger | Risk |
|---|---|---|---|
| C1 | Keep `asArray`/`asObject` permanently — do **not** remove at cutover | — | none |
| C2 | After **R1** ships, delete the `result` fallback branch in `normalize.js:12`; keep `data` branch | R1 merged + verified | low |
| C3 | After **R2** ships, switch `apiClient.js:43` to `error.code` with string fallback during transition window | R2 merged behind version flag | medium (coordinated) |
| C4 | When IAM/folio/HK/night-audit screens are built (Phase 23/24), add the missing read adapters (§4.3) rather than client-side derivation | Phase 23 | low |

**Net:** post-cutover, the frontend should converge to `asArray`/`asObject`-only coercion with
no envelope-compatibility branches. Cleanup is **not required before cutover**.

---

## 7. Scores, Risk & Decision

Full scoring is in [`QYRVIA_CONTRACT_STABILITY_REPORT.md`](./QYRVIA_CONTRACT_STABILITY_REPORT.md);
risk assessment and the cutover decision are in
[`QYRVIA_CUTOVER_READINESS_FINAL.md`](./QYRVIA_CUTOVER_READINESS_FINAL.md). Headline:

| Metric | Score |
|---|---|
| Backend Contract Stability | **96%** |
| Frontend Integration Stability | **95%** |
| API Envelope Consistency | **88%** |
| Cutover Readiness | **90%** |
| **Decision** | **CONDITIONAL APPROVAL — cleared for Phase 23/24** |

---

## 8. Constraints honored
- ✅ No UI changes. ✅ No new APIs. ✅ No business-logic expansion. ✅ No schema changes.
- ✅ No frontend behavior refactor. ✅ **Zero runtime code modified** — validation + docs only.

## 9. Deliverable index
1. **This document** — `docs/QYRVIA_PHASE22B_FINAL_CONTRACT_FREEZE.md`
2. **Contract Stability Report** — `docs/QYRVIA_CONTRACT_STABILITY_REPORT.md`
3. **Cutover Readiness (Final)** — `docs/QYRVIA_CUTOVER_READINESS_FINAL.md`
4. **Legacy Contract Deviation Report** — §2 above
5. **Frontend Dependency Cleanup Plan** — §6 above
