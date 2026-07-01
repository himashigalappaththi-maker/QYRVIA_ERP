# QYRVIA Phase 23 — Step 2: Safe Envelope Normalization Plan

**Phase:** Contract Convergence & Envelope Unification — **Step 2 (planning only).**
**Mode:** DESIGN / PLANNING. **No code, endpoint, frontend, schema, or behavioral changes were made in this step.**
**Inputs (read live for this plan):**
- `docs/QYRVIA_PHASE23_STEP1_CONTRACT_INVENTORY.md`
- `docs/QYRVIA_PHASE22B_FINAL_CONTRACT_FREEZE.md`
- `docs/QYRVIA_CONTRACT_STABILITY_REPORT.md`
- Live code: `server/src/{revenue,channel-manager,platform}/api/*.controller.js`,
  `server/src/middleware/error.js`, `frontend-stitch/src/services/{apiClient,index}.js`,
  `frontend-stitch/src/utils/normalize.js`, plus backend & frontend test suites.

---

## 0. Executive summary

Two — and only two — deviations remain on the SPA-consumed surface:

| ID | Deviation | Endpoints | Breaking? | Recommended strategy |
|---|---|---:|:---:|---|
| **R1** | GET reads emit `{ ok, result }` instead of `{ ok, data }` | 13 | **No** | **Option A — replace `result` with `data`** (single-line helper change per controller) |
| **R2** | Errors are `{ ok:false, error:"CODE" }` instead of `{ ok:false, error:{ code, message } }` | all + global handler | **Yes (coordinated)** | **Staged dual-read rollout** — consumer-first, producer-second, behind no behavioral change |

**Headline recommendation:** R1 and R2 must be sequenced as **two independent migrations**, R1 first.
R1 is a non-breaking, low-risk, reversible producer-only change because the frontend normalizer
already prefers `data` over `result` (`normalize.js:11-12`). R2 is a coordinated breaking change
because both `apiClient.js:41` and the view-level `e.message` display depend on `error` being a
string; it must follow a **consumer-tolerant-first** sequence so producer and consumer are never
incompatible at any commit.

Why **not** the dual-envelope (Option B `{ ok, data, result }`) for R1: it is unnecessary. The
consumer already tolerates both keys today, so the transitional safety net that Option B exists to
provide is already present *inside the consumer*. Option B would ship redundant payload bytes and
leave a second cleanup (removing `result`) to do later. Option A reaches the target in one
reversible step. Option B is retained only as the **rollback-free fallback** if, against evidence,
any unknown consumer is discovered mid-rollout (see §6).

---

## TASK 1 — R1 Migration Strategy (GET `result` → `data`)

### 1.1 R1 Migration Matrix (all 13 endpoints)

| # | Module | Route | Method | Current | Target | Frontend adapter (consumer) | View consumption path | Risk |
|---|---|---|:---:|---|---|---|---|:---:|
| 1 | Revenue | `/api/revenue/rate` | GET | `{ ok, result }` | `{ ok, data }` | `services.revenue.rate` | (adapter defined; not directly view-bound) | LOW |
| 2 | Revenue | `/api/revenue/rate-grid` | GET | `{ ok, result }` | `{ ok, data }` | `services.revenue.rateGrid` | `Revenue.view.js` → `asArray`/`asObject` | LOW |
| 3 | Revenue | `/api/revenue/forecast` | GET | `{ ok, result }` | `{ ok, data }` | `services.revenue.forecast` | `Revenue.view.js` → `asArray`/`asObject` | LOW |
| 4 | Revenue | `/api/revenue/kpis` | GET | `{ ok, result }` | `{ ok, data }` | `services.revenue.kpis` | `Revenue.view.js` → `asObject` | LOW |
| 5 | Revenue | `/api/revenue/dashboard` | GET | `{ ok, result }` | `{ ok, data }` | `services.revenue.dashboard` | `Revenue.view.js` → `asObject` | LOW |
| 6 | Channel | `/api/channel/status` | GET | `{ ok, result }` | `{ ok, data }` | `services.channel.status` | `Channel.view.js` → `asObject` | LOW |
| 7 | Platform | `/api/platform/admin/metrics` | GET | `{ ok, result }` | `{ ok, data }` | `services.platform.metrics` | `Admin.view.js` → `asObject` | LOW |
| 8 | Platform | `/api/platform/admin/logs` | GET | `{ ok, result }` | `{ ok, data }` | `services.platform.logs` | `Admin.view.js` → `asArray` | LOW |
| 9 | Platform | `/api/platform/admin/audit` | GET | `{ ok, result }` | `{ ok, data }` | `services.platform.audit` | `Admin.view.js` → `asArray` | LOW |
| 10 | Platform | `/api/platform/integrations/status` | GET | `{ ok, result }` | `{ ok, data }` | `services.platform.integrations` | `Admin.view.js` → `asArray`/`asObject` | LOW |
| 11 | Platform | `/api/platform/enterprise/properties` | GET | `{ ok, result }` | `{ ok, data }` | `services.platform.properties` | `Admin.view.js` → `asArray` | LOW |
| 12 | Platform | `/api/platform/enterprise/analytics` | GET | `{ ok, result }` | `{ ok, data }` | `services.platform.analytics` | `Admin.view.js` → `asObject` | LOW |
| 13 | Platform | `/api/platform/enterprise/config` | GET | `{ ok, result }` | `{ ok, data }` | `services.platform.config` | `Admin.view.js` → `asObject` | LOW |

> Every consumer reaches the payload exclusively through `asArray()` / `asObject()` →
> `unwrap()` (Phase 22B §3.1 measured **0** direct `unwrap()`/property-access call sites). Because
> `unwrap()` checks `data` **before** `result` (`normalize.js:11-12`), the change is invisible to
> all 13 consumers.

### 1.2 Producer-side change surface (the actual edit, for Step 3 — not done here)

R1 is **three one-line helper edits** plus one inline cluster — no per-endpoint edits:

| File | Locus | Change |
|---|---|---|
| `server/src/revenue/api/revenue.controller.js` | `:11` `ok(res,req,result)` | emit `{ ok:true, data:result, requestId }` |
| `server/src/platform/api/platform.controller.js` | `:7` `ok(res,req,result)` | emit `{ ok:true, data:result, requestId }` |
| `server/src/channel-manager/api/channel.controller.js` | `:65` (`status` only) | emit `{ ok:true, data: channelManager.status(), requestId }` |

**Critical scoping note (channel):** `channel.controller.js` has **no shared `ok()` helper** — the
write handlers inline `res.json({ ok:true, result:out })` at `:23,32,41,50,59,65`. Only `:65`
(`status`, the single GET) may change to `data`. The five POST writes at `:23,32,41,50,59` **must
remain `result`** (they conform to the WRITE target). This is the one place where a careless
"replace `result`→`data` in this file" would wrongly convert writes. Step 3 must touch line 65
only.

Revenue and Platform are safe to edit at the helper because every **write** in those controllers is
also supposed to emit `result` — but those controllers reuse the *same* `ok()` helper for reads and
writes (`revenue.controller.js` `setRatePlan`/`override`; `platform.controller.js` `webhook`/`sync`).
Therefore changing the shared helper to `data` would also change the writes. **This forces a
read-specific helper.**

### 1.3 R1 producer design — introduce a read helper (resolves §1.2 collision)

For Revenue and Platform, do **not** repurpose `ok()`. Add a sibling:

```
okRead(res, req, data)   → res.json({ ok:true, data,   requestId })   // GET
ok    (res, req, result) → res.json({ ok:true, result, requestId })   // POST/PUT/DELETE (unchanged)
```

- Revenue: point `getRate`, `rateGrid`, `forecast`, `kpis`, `dashboard` at `okRead`; leave
  `setRatePlan`, `override` on `ok`.
- Platform: point `metrics`, `logs`, `audit`, `integrationsStatus`, `properties`, `analytics`,
  `config` at `okRead`; leave `webhook`, `sync` on `ok`.
- Channel: only `status` changes — inline it to `data`; the five writes are untouched.

This keeps writes byte-identical (zero write-path risk) and isolates the change to reads.

### 1.4 Recommended R1 strategy & justification

**Recommendation: Option A (replace `result` with `data` on reads), via a read-specific helper,
rolled out module-by-module (Revenue → Channel → Platform).**

Justification:
1. **The consumer is already forward-compatible.** `normalize.js:11-12` prefers `data`. No
   frontend change is required at any point; there is no window of incompatibility. (Step 1 §C.2,
   Phase 22B §3.1 — both confirm `unwrap` prefers `data`, 0 direct call sites.)
2. **No backend HTTP test asserts the `result` envelope for these 13 GETs.** The
   revenue/platform/channel suites (`server/test/{revenue,platform,channel_*}.test.js`) exercise
   the engine/core layer directly, not the controller envelope (verified: no `res.body`/`.result`/
   supertest assertions in those files). So Option A breaks no existing backend test.
3. Option B (dual `{ data, result }`) buys nothing the consumer doesn't already provide, ships
   redundant bytes, and defers a second `result`-removal cleanup. Option A is strictly simpler and
   still trivially reversible (revert the helper).
4. Module-by-module staging gives three independent verification + rollback points instead of one
   big-bang.

**Rollback:** revert the per-controller helper change. Because the consumer reads both keys, even a
partial rollback (e.g., Revenue reverted, Platform shipped) is consistent end-to-end at every commit.

---

## TASK 2 — R2 Migration Strategy (string error → `{ code, message }`)

### 2.1 R2 dependency trace (every string-error producer and consumer)

| Layer | File / locus | Role | Current shape | Depends on string? |
|---|---|---|---|:---:|
| Producer (validation) | `revenue.controller.js:10` `fail()` | explicit 400s | `{ ok:false, error:"CODE", requestId }` | emits |
| Producer (validation) | `channel.controller.js:13` `fail()` | explicit 400s | `{ ok:false, error:"CODE", requestId }` | emits |
| Producer (validation) | `platform.controller.js:8` `fail()` | explicit 400s | `{ ok:false, error:"CODE", requestId }` | emits |
| Producer (global) | `middleware/error.js:22-28` `errorHandler` | thrown/500 | `{ error:"CODE", detail:"msg", requestId }` | emits |
| Producer (global) | `middleware/error.js:10-15` `notFound` | 404 | `{ error:"not_found", path, requestId }` | emits |
| Transport | HTTP body (no transform) | — | passthrough | n/a |
| Consumer (client) | `apiClient.js:41` | reads code | `(data && data.error)` → `ApiError(status, code, data)` | **YES — reads `error` as string** |
| Consumer (client) | `apiClient.js:6` `ApiError` ctor | `super(code ...)` sets `message = code` | string | **YES — message derived from string code** |
| Consumer (views) | e.g. `Revenue.view.js:37,64,93`, `useApi.js:17`, all `*.view.js` catch blocks | display | `(e && e.message) || 'fallback'` | **YES (indirect)** — `e.message` is the string code |
| Consumer (test) | `frontend-stitch/test/apiClient.test.js:40-42` | asserts | expects `e.code === 'room_type_id_required'` from `{ error:'…' }` | **YES — hard-coded string assertion** |

### 2.2 Breakage points (what fails the instant the producer emits a nested object, with no consumer change)

1. **`apiClient.js:41`** — `(data && data.error)` becomes the **object** `{code,message}`. `ApiError`
   is then constructed with `code = {object}`. `e.code` is no longer the string code.
2. **`apiClient.js:6`** — `super(code || …)` → `message` becomes `String({object})` =
   `"[object Object]"`. Every view that shows `e.message` (`Revenue.view.js`, `useApi.js:17`, and
   every other module catch block) renders `[object Object]`.
3. **`frontend-stitch/test/apiClient.test.js:40-42`** — asserts `e.code === 'room_type_id_required'`;
   fails immediately (the test feeds `{ error:'room_type_id_required' }` today; under nested shape
   `e.code` is an object).
4. No backend test breaks: backend suites assert `fail`/error at the **engine** level
   (`assert.equal(bad.ok,false)` etc.), not the HTTP error envelope. The global `error.js` shape is
   not asserted by any envelope test.

### 2.3 R2 Migration Matrix

| Step | Component | Action | Reversible? | Breaks anything at this commit? |
|---|---|---|:---:|:---:|
| R2-1 | `apiClient.js:41` + `ApiError` | Make consumer **tolerant of both**: `const raw = data && data.error; const code = (raw && typeof raw === 'object') ? raw.code : raw; const message = (raw && typeof raw === 'object') ? raw.message : undefined;` then `new ApiError(status, code || 'request_failed', data)` and set `this.message = message || code || ('http_'+status)`. | Yes | **No** — still accepts today's string producers. |
| R2-2 | `frontend-stitch/test/apiClient.test.js` | Add a nested-error case **alongside** the existing string case (both must pass). | Yes | No — additive. |
| R2-3 | `middleware/error.js:22-28` | Emit `{ ok:false, error:{ code, message }, requestId }` (keep `requestId`; fold `detail` into `error.message`). | Yes | **No** — consumer already tolerant after R2-1. |
| R2-4 | controllers' `fail()` (`revenue:10`, `channel:13`, `platform:8`) | Emit `{ ok:false, error:{ code, message }, requestId }`. | Yes | **No** — consumer tolerant. |
| R2-5 | `apiClient.js` (optional, later) | Remove the string fallback branch once **all** producers are nested + a deprecation window passes. | Yes | Would break only if a string producer remains — gate on grep proof. |

### 2.4 Safest R2 sequence (consumer-tolerant-first — the invariant)

**Invariant: the consumer must accept both shapes BEFORE any producer emits the new shape, and the
old shape must remain accepted until the last producer is migrated.** This guarantees no commit has
an incompatible producer/consumer pair.

```
R2-1  Consumer: make apiClient read string OR { code, message }  (no producer change)
R2-2  Tests:    add nested-error test next to the existing string test (both green)
        ── safe checkpoint: nothing emits nested yet; consumer ready ──
R2-3  Producer: migrate global error.js  → nested
R2-4  Producer: migrate the three fail() helpers → nested  (module-by-module ok)
        ── safe checkpoint: all producers nested; consumer still dual ──
R2-5  Cleanup:  remove string fallback only after grep proves 0 string producers remain
```

`ApiError.message` must be set explicitly to `message || code` (R2-1) so views keep showing a
human string and **never** `[object Object]` — this is what protects every `e.message` consumer
(§2.1) without touching a single view file.

---

## TASK 3 — Compatibility Matrix

### 3.1 R1 chain — Backend producer → transport → apiClient → services → normalize → views

| Stage | Today (`result`) | After Option A (`data`) | Compatible? |
|---|---|---|:---:|
| Backend producer | `{ ok, result }` | `{ ok, data }` | change origin |
| Transport (HTTP) | passthrough | passthrough | ✅ |
| `apiClient` | returns whole body (does not read `data`/`result`) `apiClient.js:42` | identical | ✅ neutral |
| `services.*` | passes body through (`services/index.js:125-172`) | identical | ✅ neutral |
| `normalize.unwrap` | `result` branch hit (`:12`) | `data` branch hit (`:11`, checked first) | ✅ both handled |
| Views | `asArray`/`asObject` payload | identical payload | ✅ |

**Where it would break:** nowhere. The only stage that inspects the key is `normalize.unwrap`, and
it already prefers `data`. Residual `result` branch (`normalize.js:12`) becomes dead for these
modules — retire later (cleanup C2), not required.

### 3.2 R2 chain — Backend error producer → transport → apiClient → ApiError → views/tests

| Stage | Today (string) | If producer flips first (WRONG order) | After R2-1 consumer-first (CORRECT) |
|---|---|---|---|
| Producer | `error:"CODE"` | `error:{code,message}` | `error:{code,message}` |
| Transport | passthrough | passthrough | passthrough |
| `apiClient.js:41` | `code = data.error` (string) | `code = {object}` ❌ | reads string OR object ✅ |
| `ApiError` message | `= code` (string) | `"[object Object]"` ❌ | `= message || code` ✅ |
| Views (`e.message`) | shows code string | shows `[object Object]` ❌ | shows message/code ✅ |
| `apiClient.test.js:40-42` | passes | **fails** ❌ | passes (dual test) ✅ |

**Where it would break:** `apiClient.js:41`, `apiClient.js:6` (message), every `e.message` view, and
`apiClient.test.js` — **all of them break only under the wrong (producer-first) order.** The
consumer-first sequence (§2.4) keeps every stage compatible at every commit.

---

## TASK 4 — Test Impact Analysis (no test modified in this step)

### 4.1 Backend tests

| Suite | Asserts the 13-GET envelope? | Asserts string-error HTTP envelope? | Impact |
|---|:---:|:---:|---|
| `server/test/revenue.test.js` | No (engine-level) | No | R1/R2 = none |
| `server/test/platform.test.js` | No (engine-level) | No | R1/R2 = none |
| `server/test/channel_*.test.js` | No (core/canonical-level) | No | R1/R2 = none |
| `server/test/app.test.js` | No revenue/channel/platform envelope refs | — | none |
| **Gap** | — | — | **No backend HTTP contract test exists for these 13 reads or for the error envelope.** |

> Consequence: R1 can ship without breaking a backend test — but also **without** a backend test
> proving it. Step 3 should **add** a thin contract test per controller (assert GET → `data`, POST →
> `result`) so the converged contract is locked. This is net-new coverage, not a modification.

### 4.2 Frontend tests

| Suite | Relevant assertions | R1 impact | R2 impact |
|---|---|---|---|
| `frontend-stitch/test/normalize.test.js:6-7,14-24` | `unwrap`/`asArray`/`asObject` handle both `data` and `result` | none (both still pass; keep `result` cases as regression guard) | none |
| `frontend-stitch/test/apiClient.test.js:40-42` | `e.code === 'room_type_id_required'` from `{ error:"…" }` | none | **Directly affected** — must gain a nested-error case (R2-2). Keep the string case until producers fully migrate. |
| `frontend-stitch/test/services.test.js` | service→route mapping | none | none |

### 4.3 Contract tests required (to add in Step 3)

1. **Backend envelope contract test** (new): for each controller, GET returns `{ ok:true, data }`,
   writes return `{ ok:true, result }`. Closes the §4.1 gap.
2. **Backend error-envelope test** (new, with R2): `fail()` and global handler return
   `{ ok:false, error:{ code, message } }`.
3. **Frontend dual-error test** (R2-2): `apiClient` surfaces `code`+`message` from both string and
   nested shapes.

### 4.4 Regression risks

| Risk | Likelihood | Detection |
|---|:---:|---|
| Channel writes accidentally converted to `data` (§1.2) | low | new backend contract test (writes must stay `result`) |
| A view reads `res.result` directly somewhere unmeasured | very low (Phase 22B: 0 direct unwrap/property sites) | grep `\.result` / `\.data` in `src/modules` before R1 |
| `e.message` renders `[object Object]` under R2 | medium **if** producer-first order used | enforced by R2-1-before-R2-3 sequencing + dual test |
| An unmigrated string producer after fallback removal (R2-5) | low | gate R2-5 on `grep -rn "error:" server/src` proving 0 string producers |

---

## TASK 5 — Implementation Blueprint (real loci, with rollback points)

> **Ordering rule:** R1 fully lands and is verified **before** R2 begins. They are independent;
> interleaving adds risk for no benefit.

### Stage 0 — Pre-flight (verification, no change)
- Run `server` `npm test` and `frontend-stitch` `npm test`; record green baseline
  (Phase 22B baseline: 455/0/3 and 27/0).
- `grep -rn "\.result\|\.data" frontend-stitch/src/modules` to re-confirm 0 direct envelope reads.
- **Rollback point: clean tree.**

### Stage 1 — R1 producer convergence (module-by-module)
- 1a. Revenue: add `okRead` (emit `data`); point the 5 GET handlers at it; leave `setRatePlan`/
  `override` on `ok`. (`revenue.controller.js`)
- 1b. Channel: change `status` only (`channel.controller.js:65`) to emit `data`; **do not touch**
  the 5 inline write `result`s.
- 1c. Platform: add `okRead`; point the 7 GET handlers at it; leave `webhook`/`sync` on `ok`.
  (`platform.controller.js`)
- Verify after each: backend tests green (no envelope assertions exist, so they stay green); manual
  smoke of Revenue/Channel/Admin views (data still renders via `unwrap`'s `data` branch).
- **Rollback point after each sub-stage:** revert the single controller; consumer tolerates both, so
  a partial state is consistent.

### Stage 2 — R1 lock-in (new coverage, no behavior change)
- Add backend envelope contract test (§4.3.1). Optionally retire `normalize.js:12` `result` branch
  (cleanup C2) — **defer**; keep as harmless regression guard until R3+.
- **Rollback point: remove the new test.**

### Stage 3 — R2 consumer-tolerant-first
- 3a. `apiClient.js:41`/`:6`: read string OR `{code,message}`; set `ApiError.message = message ||
  code` (R2-1).
- 3b. `apiClient.test.js`: add nested-error case beside the string case (R2-2).
- Verify: frontend tests green for **both** shapes.
- **Rollback point: revert apiClient + test; producers still string → fully compatible.**

### Stage 4 — R2 producer convergence
- 4a. `middleware/error.js:22-28` + `:10-15` → nested `{ ok:false, error:{code,message}, requestId }`
  (R2-3).
- 4b. `fail()` in `revenue.controller.js:10`, `channel.controller.js:13`, `platform.controller.js:8`
  → nested (R2-4); add backend error-envelope test (§4.3.2).
- Verify after each: full backend + frontend suites green; views show human messages (not
  `[object Object]`).
- **Rollback point after each:** revert the producer; consumer (Stage 3) tolerates both.

### Stage 5 — Final validation & legacy removal
- Full `npm test` both sides; manual error-path smoke (force a 400 in Revenue, confirm toast text).
- `grep -rn "error:" server/src` → prove **0** string-error producers remain.
- Only then: remove the apiClient string fallback (R2-5) and the `apiClient.test.js` string case;
  retire `normalize.js:12` `result` branch (C2).
- **Rollback point: keep the dual-read fallback** if any string producer is found — fallback removal
  is the only step that is not independently reversible, so it is gated on grep proof.

---

## TASK 6 — Risk & Rollback Plan

| Stage | Change | Breaking? | Risk | Rollback |
|---|---|:---:|:---:|---|
| 1 (R1) | reads → `data` via read helper | No | LOW | revert controller; consumer reads both |
| 2 | add backend contract test | No | NONE | delete test |
| 3 (R2-1/2) | consumer tolerant of both error shapes | No | LOW | revert apiClient+test |
| 4 (R2-3/4) | producers → nested error | **Yes**, but consumer already tolerant | LOW (given Stage 3 first) | revert producer; consumer still tolerant |
| 5 | remove string fallback / legacy branches | **Yes** | MEDIUM | **gated** on grep = 0 string producers; if any remain, keep fallback |

**Global rollback property:** because both consumers (R1: `unwrap` prefers `data`; R2: dual-read
apiClient) accept the legacy shape throughout Stages 1–4, **every commit is end-to-end consistent**
and any single stage can be reverted in isolation. The only one-way door is Stage 5 fallback
removal, which is explicitly gated.

**Net post-Step-3 state:** READ `{ ok, data }`, WRITE `{ ok, result }`, ERROR
`{ ok:false, error:{ code, message } }` across Revenue/Channel/Platform — closing L1 + L2 and
lifting API Envelope Consistency toward the ≥95% target (Stability Report §3).

---

## Constraints honored (Step 2)
- ✅ No code changes. ✅ No UI changes. ✅ No schema changes. ✅ No endpoint additions.
  ✅ No behavior changes. **This step produced documentation only.**

## Deliverable index
1. **This document** — `docs/QYRVIA_PHASE23_STEP2_NORMALIZATION_PLAN.md`
2. **R1 Migration Matrix** — §1.1
3. **R2 Migration Matrix** — §2.3 (with dependency trace §2.1, breakage points §2.2)
4. **Compatibility Chain Diagram** — §3.1 (R1), §3.2 (R2)
5. **Implementation Blueprint** — §5
6. **Risk & Rollback Plan** — §6

## Success criteria — checklist
| Criterion | Status |
|---|:---:|
| Complete migration strategy documented (R1 + R2) | ✅ §1, §2 |
| Every breakage point identified | ✅ §2.2, §3.2, §4.2 |
| Rollback path defined | ✅ §5, §6 |
| Implementation ready for Step 3 | ✅ staged blueprint with real loci |
| Zero code modified | ✅ planning only |
