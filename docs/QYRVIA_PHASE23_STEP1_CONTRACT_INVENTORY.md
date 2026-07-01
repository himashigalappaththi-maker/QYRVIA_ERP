# QYRVIA Phase 23 — Step 1: Contract Inventory & Classification

**Phase:** Contract Convergence & Envelope Unification — **Step 1 (inventory only).**
**Mode:** READ-ONLY analysis. **No code, refactor, UI, schema, or behavioral changes.**
**Scope (strict):** `server/src/revenue/*`, `server/src/channel-manager/*`,
`server/src/platform/*`, and their shared response helpers/error middleware.

**Evidence base (read live for this report):**
- `server/src/revenue/api/{revenue.routes,revenue.controller}.js`
- `server/src/channel-manager/api/{channel.routes,channel.controller}.js`
- `server/src/platform/api/{platform.routes,platform.controller}.js`
- `server/src/middleware/error.js` (global error handler)
- `frontend-stitch/src/services/index.js`, `frontend-stitch/src/utils/normalize.js`,
  `frontend-stitch/src/services/apiClient.js`

---

## 0. Target contract (final state)

```
READ  (GET)              → { ok: true,  data:   <payload> }
WRITE (POST/PUT/DELETE)  → { ok: true,  result: <payload> }
ERROR (final)            → { ok: false, error: { code, message } }
```

---

## A. Endpoint table

### A.1 Revenue (`/api/revenue`) — `revenue.controller.js`

Helper in use: `ok(res,req,result) → { ok:true, result }` (`revenue.controller.js:11`);
`fail(res,req,code) → { ok:false, error:<string> }` (`:10`).

| Module | Endpoint | Method | Op | Current shape | Target shape | Conforms? | Risk |
|---|---|---|---|---|---|:---:|:---:|
| Revenue | `/rate` | GET | READ | `{ ok, result }` | `{ ok, data }` | ❌ | LOW |
| Revenue | `/rate-grid` | GET | READ | `{ ok, result }` | `{ ok, data }` | ❌ | LOW |
| Revenue | `/forecast` | GET | READ | `{ ok, result }` | `{ ok, data }` | ❌ | LOW |
| Revenue | `/kpis` | GET | READ | `{ ok, result }` | `{ ok, data }` | ❌ | LOW |
| Revenue | `/dashboard` | GET | READ | `{ ok, result }` | `{ ok, data }` | ❌ | LOW |
| Revenue | `/rate-plan` | POST | WRITE | `{ ok, result }` | `{ ok, result }` | ✅ | NONE |
| Revenue | `/override` | POST | WRITE | `{ ok, result }` | `{ ok, result }` | ✅ | NONE |

### A.2 Channel Manager (`/api/channel`) — `channel.controller.js`

No shared `ok()` helper — each handler inlines `res.json({ ok:true, result:out })`
(`channel.controller.js:23,32,41,50,59,65`); `fail()` → `{ ok:false, error:<string> }` (`:13`).

| Module | Endpoint | Method | Op | Current shape | Target shape | Conforms? | Risk |
|---|---|---|---|---|---|:---:|:---:|
| Channel | `/sync/rates` | POST | WRITE | `{ ok, result }` | `{ ok, result }` | ✅ | NONE |
| Channel | `/sync/inventory` | POST | WRITE | `{ ok, result }` | `{ ok, result }` | ✅ | NONE |
| Channel | `/bookings/sync` | POST | WRITE | `{ ok, result }` | `{ ok, result }` | ✅ | NONE |
| Channel | `/bookings/confirm` | POST | WRITE | `{ ok, result }` | `{ ok, result }` | ✅ | NONE |
| Channel | `/bookings/cancel` | POST | WRITE | `{ ok, result }` | `{ ok, result }` | ✅ | NONE |
| Channel | `/status` | GET | READ | `{ ok, result }` | `{ ok, data }` | ❌ | LOW |

### A.3 Platform (`/api/platform`) — `platform.controller.js`

Helper: `ok(res,req,result) → { ok:true, result }` (`platform.controller.js:7`);
`fail()` → `{ ok:false, error:<string> }` (`:8`).

| Module | Endpoint | Method | Op | Current shape | Target shape | Conforms? | Risk |
|---|---|---|---|---|---|:---:|:---:|
| Platform | `/admin/metrics` | GET | READ | `{ ok, result }` | `{ ok, data }` | ❌ | LOW |
| Platform | `/admin/logs` | GET | READ | `{ ok, result }` | `{ ok, data }` | ❌ | LOW |
| Platform | `/admin/audit` | GET | READ | `{ ok, result }` | `{ ok, data }` | ❌ | LOW |
| Platform | `/integrations/status` | GET | READ | `{ ok, result }` | `{ ok, data }` | ❌ | LOW |
| Platform | `/integrations/webhook` | POST | WRITE | `{ ok, result }` | `{ ok, result }` | ✅ | NONE |
| Platform | `/integrations/sync` | POST | WRITE | `{ ok, result }` | `{ ok, result }` | ✅ | NONE |
| Platform | `/enterprise/properties` | GET | READ | `{ ok, result }` | `{ ok, data }` | ❌ | LOW |
| Platform | `/enterprise/analytics` | GET | READ | `{ ok, result }` | `{ ok, data }` | ❌ | LOW |
| Platform | `/enterprise/config` | GET | READ | `{ ok, result }` | `{ ok, data }` | ❌ | LOW |

### A.4 Coverage totals (100% of in-scope endpoints mapped)

| Module | Endpoints | READ (GET) | WRITE | Reads non-conforming (`result`) | Writes non-conforming |
|---|---:|---:|---:|---:|---:|
| Revenue | 7 | 5 | 2 | 5 | 0 |
| Channel | 6 | 1 | 5 | 1 | 0 |
| Platform | 9 | 6 | 3 | 6 | 0 |
| **Total** | **22** | **12** | **10** | **13** | **0** |

> Note: `POST /platform/integrations/webhook` and `/integrations/sync` are write-verbed and
> emit `result` — conforming. `integrations/webhook` additionally returns the engine's own
> `{ ok, ... }` object *inside* `result` when accepted (`platform.controller.js:19-21`); the
> outer envelope is still `{ ok, result }`.

---

## B. Deviation classification

### B.1 GET endpoints returning `result` (should be `data`) — **13 (HIGH-priority for Step 2)**
All five Revenue GETs, the one Channel GET (`/status`), and all six Platform GETs.
Root cause: each controller's single `ok()` helper hard-codes the `result` key and is reused for
both reads and writes. **There is no read-specific helper.** This is the primary convergence
target.

### B.2 WRITE endpoints using inconsistent keys — **0**
All 10 write endpoints already emit `{ ok, result }`. No change required; they are the reference
for the correct write shape.

### B.3 String-based errors — **universal (all 22 endpoints + global handler)**
- Explicit validation failures → `fail()` → `{ ok:false, error:"<string_code>", requestId }`
  (revenue `:10`, channel `:13`, platform `:8`).
- Thrown/unexpected errors → `next(e)` → global handler →
  `{ error:"<string_code>", detail:"<message>", requestId }` (`middleware/error.js:22-28`),
  status from `err.status` else 500.
- **Neither path uses the target nested `{ code, message }`.** 100% string-based, 100% consistent.

### B.4 Hybrid / ambiguous envelopes — **0**
No endpoint mixes `data` and `result`, and no endpoint conditionally switches keys. Within each
controller the success key is uniformly `result`. The only "nesting" case (B.1 note: webhook)
keeps a clean outer `{ ok, result }`. **No hybrid envelopes exist.**

### B.5 Deviation summary

| Deviation | Count | Endpoints | Step-2 disposition |
|---|---:|---|---|
| GET returns `result` | 13 | §B.1 | Convert helper to emit `data` for reads |
| WRITE inconsistent key | 0 | — | none |
| String errors | 22 + global | all | Nested-error envelope (breaking — separate sub-step) |
| Hybrid envelopes | 0 | — | none |

---

## C. Dependency notes

### C.1 Frontend reliance (current consumers)

| Module | Frontend service | Reads consumed by view |
|---|---|---|
| Revenue | `services.revenue.{rate,rateGrid,forecast,kpis,dashboard,setRatePlan,override}` | `Revenue.view.js` uses `rateGrid,forecast,kpis,dashboard` (+ `override` write) |
| Channel | `services.channel.{status,syncRates,syncInventory,syncBookings,confirmBooking,cancelBooking}` | `Channel.view.js` uses `status` (read) + sync writes |
| Platform | `services.platform.{metrics,logs,audit,integrations,properties,analytics,config}` | `Admin.view.js` uses all 7 reads |

All reads are consumed through `asArray()` / `asObject()` — **never via direct property access**
on `res.data` or `res.result`.

### C.2 Normalization dependency impact (the key safety finding)

`frontend-stitch/src/utils/normalize.js`:
```js
unwrap(res):  if has 'data'   → res.data      // checked FIRST
              if has 'result' → res.result    // checked SECOND  (normalize.js:11-12)
asArray/asObject → call unwrap() then coerce
```

**Consequence for Step 2:** converting these 13 GETs from `result` → `data` is **safe and
non-breaking** under any rollout:
- *Replace* `result` with `data`: `unwrap()` finds `data` → works.
- *Add* `data` alongside `result`: `unwrap()` prefers `data` (checked first) → works.
- *Leave* `result`: still works today.

So the read-key convergence (B.1) carries **LOW risk** end-to-end. The residual `result`-branch in
`normalize.js:12` becomes dead for these modules once converted and can be retired later
(tracked as cleanup, not required).

### C.3 apiClient dependency notes

`frontend-stitch/src/services/apiClient.js`:
- The client returns the **entire response body**; it does **not** read `data`/`result` itself.
  → The read-key change (B.1) is **apiClient-neutral** — no client change needed.
- The client **does** read the error code as a string: `(data && data.error)` →
  `new ApiError(status, code, data)` (`apiClient.js:43`).
  → The **error-shape** change (B.3, nested `{code,message}`) **would break** this line and is
  therefore a **breaking, coordinated change** — explicitly *out of scope for the read-key
  convergence* and must be handled as its own versioned sub-step (carries MEDIUM risk).

### C.4 Risk register for Step 2

| Change | Endpoints | Breaking? | Risk | Frontend action required |
|---|---:|:---:|:---:|---|
| GET `result` → `data` | 13 | No | **LOW** | None (absorbed by `unwrap`); optional later cleanup of `normalize.js:12` |
| String error → `{code,message}` | all | **Yes** | MEDIUM | Update `apiClient.js:43` with versioned fallback — **defer to dedicated sub-step** |

---

## Step 1 success criteria — checklist

| Criterion | Status |
|---|:---:|
| 100% of in-scope endpoints mapped | ✅ 22/22 (Revenue 7, Channel 6, Platform 9) |
| All deviations classified | ✅ B.1–B.5 |
| No missing module coverage | ✅ all three modules + shared helpers + global error handler |
| Frontend dependency risks identified | ✅ C.1–C.4 |
| Ready for Step 2 (safe refactor planning) | ✅ — read-key convergence is LOW-risk; error-shape isolated as breaking sub-step |

---

## Next step (NOT performed here)

**Step 2 — Safe envelope normalization plan (incremental, zero-breakage):**
recommended sequence — (1) introduce a read helper emitting `data` and convert the 13 GETs
module-by-module (LOW risk, no frontend change); (2) verify via existing tests; (3) handle the
nested-error envelope separately behind a version flag with a coordinated `apiClient` update.
