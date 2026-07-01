# QYRVIA Phase 23 — Step 5: Cutover Policy & Contract Enforcement Design

**Mode:** ANALYSIS / DESIGN ONLY. **No code, UI, schema, endpoint, or implementation changes.**
Evaluates the dual-envelope system shipped in Steps 3–4 and sets the final cutover policy.

**Evidence base (read live):** `server/src/routes/{pms,finance,core}.js`, `server/src/app.js`,
`server/src/core/{commandBus,queryBus,aggregateStore}.js`, `server/src/middleware/{error,errorEnvelope}.js`,
the three module controllers, `frontend-stitch/src/services/apiClient.js`, and the full backend test
suite (`server/test/**`).

---

## 0. Decisive architectural finding (read this first)

**The `ERROR_ENVELOPE=object` flag is NOT global.** It only changes error output at two places:

| Routed through `errorField` (flag-sensitive) | Bypasses `errorField` (always string, flag-blind) |
|---|---|
| `middleware/error.js` → `errorHandler` (thrown/500) + `notFound` (404) | **All bus outcomes** emitted directly by routes: `pms.js:25,34`, `finance.js`, `core.js:23` (`res.json(Object.assign({requestId}, outcome))`) |
| `fail()` in Revenue / Channel / Platform controllers (validation 400s) | Auth routes, `health.js`/`app.js:64` health, connectors, settings, files, jobs, notifications, webhooks |
| | The entire command/query **bus validation surface** (`commandBus.js`, `queryBus.js`) — string `error` returned as the *outcome object*, never passed through `errorField` |

**Consequence:** flipping the default to `object` today would make the backend emit a **mixed**
contract — Revenue/Channel/Platform + thrown/404 errors as `{ code, message }`, but PMS/Finance/IAM/
Auth/all bus-validation errors still as `"CODE"`. That is **less uniform than today's 100%-string
state**, which Phase 22B explicitly valued ("no envelope drift"). A global object flip would
*introduce* drift, not remove it.

This single fact drives the recommendation below.

---

## 1. Required analysis

### 1.1 Risks of switching default string → object

| Risk | Severity | Why |
|---|:---:|---|
| Producer inconsistency / contract drift | **HIGH** | Only ~4 of ~15 surfaces are flag-sensitive (§0). Object default ⇒ two error shapes coexist on the backend. |
| Test breakage | LOW–MED | `app.test.js:108` (`notFound` → `errorField`) asserts `r.body.error === 'not_found'` — breaks in object mode. No other existing HTTP test asserts a string `error` flowing through `errorField` (bus/health/auth/connector assertions all bypass it — verified at `app.test.js:37,52,70,98`). |
| Frontend breakage | **NONE** | `apiClient.js` accepts both shapes since Step 3 (test-proven), and views read `e.message`/`e.code` which are always strings regardless of producer shape. |
| Hidden string consumers | LOW | See §1.4 — no frontend code switches on a raw string `error`; all go through `ApiError`. |

### 1.2 Frontend impact if strict object mode became default

**Effectively none.** The frontend was hardened first (consumer-tolerant-first, Step 3):
- `apiClient.js` normalizes `error` (string **or** `{code,message}`) → `ApiError{ code:string, message:string }`.
- `ApiError.message = message || code`, so `[object Object]` is impossible.
- 62/62 view→service refs and all error displays use `e.message`/`e.code` — both remain strings.
- `frontend-stitch/test/apiClient.test.js` proves **both** shapes (28/0 green).

The frontend is already in "permanent dual-mode." Strict object mode would be a no-op for the UI.

### 1.3 Backend stability if string mode is fully deprecated

**Not safe today.** "Full deprecation" means removing string output everywhere — but the string shape
is produced by the **bus + route-direct layer** that does *not* route through `errorField` (§0).
Deprecating string would require a separate, larger change: routing every `commandBus`/`queryBus`
outcome and every route-direct `res.json({...error...})` through `errorField`, plus updating ~30+
backend tests that assert `r.body.error`/`r.error` as strings (e.g. `app.test.js`, `auth*.test.js`,
`commandBus.test.js`, `finance_ledger.test.js`, `folio_*`, `pms_*`). That is a Phase-of-its-own, not
a flag flip. **Until that unification ships, string mode cannot be deprecated.**

### 1.4 Remaining hidden dependencies on string errors

| Dependency | Location | Impact on cutover |
|---|---|---|
| Bus outcome contract `{ ok:false, error:'CODE', detail }` | `commandBus.js`, `queryBus.js`, `aggregateStore.js`, all `services/**` | Consumed internally + emitted route-direct; **not** flag-sensitive. Pervasive string reliance. |
| Backend HTTP tests asserting `r.body.error === '<string>'` | `app.test.js`, `auth.test.js`, `auth_multiproperty.test.js` | All except `app.test.js:108` (notFound) bypass `errorField`, so unaffected by the flag. `:108` is the one flag-sensitive assertion. |
| Backend engine tests asserting `r.error === '<string>'` | `commandBus`, `finance_ledger`, `folio_*`, `pms_*`, `notificationService`, etc. (~30 files) | Engine-level result objects, **never** HTTP/`errorField`. Untouched by any envelope decision. |
| Frontend `apiClient.test.js` string assertion | `apiClient.test.js` (legacy-string case) | Dual-mode; both string and object cases pass. |
| Frontend view error display | `Revenue.view.js`, `useApi.js:17`, all `*.view.js` | Reads `e.message` (always a string). No raw-string dependency. |

**No hidden frontend dependency on the raw string shape exists.** The deep string reliance is
entirely **backend-internal** (the bus contract), which is out of `errorField`'s reach and therefore
orthogonal to the R2 envelope decision.

### 1.5 Are R1 / R2 safe for global enforcement?

| Item | Globally enforceable now? | Basis |
|---|:---:|---|
| **R1** (GET `{ ok, data }`) | **YES — already enforced** | All 13 GETs converted (Step 3); consumer prefers `data` (`normalize.js:11-12`); 0 view changes; tests green. R1 is complete and globally safe. |
| **R2 dual-mode** (consumer accepts both; producer string default, object opt-in) | **YES — already in place** | Frontend dual (Step 3) + backend builder/flag (Step 4); default unchanged; tests green. |
| **R2 object-as-global-default** | **NO (not yet)** | Producer surface is non-uniform (§0/§1.3). A global flip creates drift and needs the bus-layer unification + ~30 test updates first. |

---

## 2. Final cutover recommendation

### **Recommended: Option 3 — Permanent dual-mode compatibility (no breaking change).**

- **Keep `ERROR_ENVELOPE=string` as the default / canonical output** for the entire consumed surface.
- **Keep the object shape opt-in and frontend-absorbed** (already true). It is the *forward standard*
  for new code, not a retroactive flip.
- **Do NOT globally flip to object** and **do NOT deprecate string** until a dedicated
  "Error-Producer Unification" phase routes the bus/route-direct layer through `errorField` and
  migrates the ~30 string-asserting backend tests.

**Why not the other two options:**

| Option | Verdict | Reason |
|---|:---:|---|
| Global flip (object default) | ❌ Reject | Produces a mixed/inconsistent backend contract (§0); breaks `app.test.js:108`; adds drift Phase 22B worked to avoid — for zero frontend benefit (UI already absorbs both). |
| Gradual module rollout (Rev→Chan→Plat) | ⚠️ Not worth it now | The flag is global, not per-module; per-module rollout would need new per-module flags (**code change — out of scope**). The three modules' error 400s aren't asserted by any backend test and are already frontend-absorbed, so "rolling them out" changes nothing observable while leaving PMS/Finance as string. Low value, adds surface. |
| **Permanent dual-mode** | ✅ **Recommend** | Zero breaking change ever; frontend already dual; honest match to the non-uniform producer reality; unblocks Phase 24 immediately; preserves the instant rollback property. |

### 2.1 If/when a future phase DOES want object everywhere — required order

Recorded for the future "Error-Producer Unification" phase (not executed here):

```
Pre-req  Route commandBus/queryBus outcomes + all route-direct error json through errorField
Stage 1  Revenue  fail()/handlers verified object  → run suite
Stage 2  Channel  fail() verified object           → run suite
Stage 3  Platform fail() verified object           → run suite
Stage 4  Global error.js (errorHandler + notFound) → update app.test.js:108 + any thrown-error asserts
Stage 5  Flip ERROR_ENVELOPE=object as default; migrate the ~30 string-asserting backend tests
Stage 6  (optional, much later) remove string branch from errorField + apiClient
```

This is the **only** order that avoids drift, because it unifies producers *before* flipping the
default.

---

## 3. Risk matrix (Backend / Frontend / Tests) per option

| Option | Backend | Frontend | Tests |
|---|---|---|---|
| **Global flip (object)** | HIGH — mixed contract / drift; bus layer still string | NONE — apiClient dual | MED — `app.test.js:108` breaks; possible thrown-error asserts |
| **Gradual module rollout** | MED — needs per-module flags (code); partial coverage | NONE | LOW — but requires new test scaffolding |
| **Permanent dual-mode (recommended)** | **LOW** — no output change; builder ready | **NONE** — already dual | **NONE** — all green (backend 459/0/3, frontend 28/0) |

---

## 4. Rollback strategy (instant, zero-downtime)

Dual-mode makes rollback a **config operation, not a deploy**:

- **Primary control:** `ERROR_ENVELOPE` env var. Default/rollback value = `string`. Flipping it back
  to `string` (or unsetting it) instantly restores legacy output on the next request — **no code
  change, no redeploy of logic, no schema touch**. Because the frontend accepts both shapes, there is
  zero client coordination and zero downtime in either direction.
- **Code rollback (only if the builder itself were faulted):** revert `middleware/error.js` +
  the three `fail()` helpers + delete `errorEnvelope.js`/`env.js` flag line; **keep `apiClient.js`**
  (the dual-read consumer is always safe). Single-file local reverts, per Step 4 §8.
- **Guarantee:** at no point does any commit or config state leave producer and consumer
  incompatible — the consumer is a superset of both producer shapes.

---

## 5. Enforcement rule for new development (error contract standard)

**Standard for all new/modified backend error producers going forward:**

1. **Never hand-write `error: '<string>'` or `error: {…}` in a controller.** Always go through the
   shared helper: `errorField(code, message)` (from `middleware/errorEnvelope.js`). This makes every
   new producer automatically flag-correct and future-proof.
2. **Always supply a human `message`** alongside the `code` so object mode carries a real sentence
   (string mode still emits just the code — no penalty).
3. **`code` is a stable, machine-readable snake_case token** (e.g. `room_type_id_required`); it is the
   contract. `message` is human-facing and may change freely.
4. **New bus/service outcomes** should likewise expose `{ ok:false, error:'code', detail? }` and,
   when surfaced over HTTP by a route, be passed through `errorField` rather than emitted raw — so the
   future unification phase has nothing left to retrofit.
5. **Frontend** must continue to consume errors only via `apiClient`/`ApiError` (`e.code`, `e.message`)
   — never by reading `res.error` directly. (Currently 100% compliant.)
6. **Reads** use `{ ok, data }`; **writes** use `{ ok, result }` (R1 — now the enforced norm).

---

## 6. Go / No-Go for Phase 24 (UI + module expansion)

### **Decision: GO.**

| Gate | Status | Evidence |
|---|:---:|---|
| R1 complete & globally safe | ✅ | 13/13 GETs `{ ok, data }`; 0 view changes; tests green |
| R2 consumer hardened | ✅ | apiClient dual-shape, `[object Object]`-proof; 28/0 |
| R2 backend builder ready | ✅ | `errorEnvelope.js` + flag; default string; 459/0/3 |
| No breaking change outstanding | ✅ | dual-mode; instant config rollback |
| Contract standard defined | ✅ | §5 enforcement rule |
| Hidden dependencies mapped | ✅ | §0/§1.4 — string reliance is backend-internal & orthogonal |
| Producer uniformity for object-default | ⚠️ (deferred) | **Not a Phase-24 blocker** — string is the stable default; object-default is a separate future phase |

**Basis:** the consumed API surface is stable and non-breaking in both shapes. R1 is enforced; R2 is
safely dual. The only unfinished item — unifying the backend producer layer so object can become the
global default — is **isolated, optional, and not on the Phase 24 critical path**. Phase 24 (UI
modernization + module expansion) can proceed against the current contract with the §5 standard
applied to all new code. **No envelope work blocks Phase 24.**

---

## 7. Constraints honored
- ✅ No code changes. ✅ No UI changes. ✅ No schema changes. ✅ No endpoint changes.
  ✅ No implementation work. **Analysis + policy only.**

## 8. Output index
1. **Final cutover recommendation** — §2 (Option 3: permanent dual-mode).
2. **Risk matrix (Backend/Frontend/Tests)** — §3 (per option) + §1.1.
3. **Migration strategy** — §2.1 (the required order *if* object-default is ever pursued).
4. **Rollback strategy** — §4 (instant, config-level, zero-downtime).
5. **Enforcement rule for new development** — §5.
6. **Go/No-Go for Phase 24** — §6 (**GO**).
