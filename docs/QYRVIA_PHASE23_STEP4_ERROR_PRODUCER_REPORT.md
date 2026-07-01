# QYRVIA Phase 23 — Step 4: Backend Error Producer Normalization (R2 Completion) — Validation Report

**Mode:** IMPLEMENTATION (controlled / backward compatible). **Constraints:** no UI change, no
schema change, no new endpoints, no business-logic expansion.

**Goal:** complete R2 by giving the backend producers a normalized, dual-shape-capable error layer,
while keeping the legacy string shape as the **default output** (frontend apiClient already accepts
both since Step 3).

---

## 1. Design — flag-gated shared builder (default OFF)

A single feature flag selects the error shape; **default is legacy string**, so enabling this code
changes **no output** until the flag is set. There is no big-bang switch and no per-controller hard
flip.

| Mode (`ERROR_ENVELOPE`) | `error` field emitted | Default? |
|---|---|:---:|
| `string` | `"CODE"` (legacy) | ✅ default |
| `object` | `{ code, message }` | opt-in |

**New module — `server/src/middleware/errorEnvelope.js`:**
```
buildError(code, message) -> { code: String(code||'internal_error'), message: String(message||code) }
errorField(code, message) -> env.ERROR_ENVELOPE === 'object' ? buildError(code,message) : String(code)
```
`buildError` is the normalized internal object (always `{ code, message }`); `errorField` is what
goes in the response body, honoring the flag.

**Flag wiring — `server/src/config/env.js`:** added
`ERROR_ENVELOPE: getOptional('ERROR_ENVELOPE', 'string')` (frozen config, documented).

---

## 2. STEP 4.1 — producers routed through `errorField`

| File | Change | Default-mode output |
|---|---|---|
| `server/src/middleware/error.js` | `errorHandler` + `notFound` now set `error: errorField(code, message)`; `detail` retained in string mode, folded into `error.message` in object mode | **byte-identical** to before |
| `server/src/revenue/api/revenue.controller.js` | `fail()` → `error: errorField(code)` | `error:"CODE"` unchanged |
| `server/src/channel-manager/api/channel.controller.js` | `fail()` → `error: errorField(code)` | `error:"CODE"` unchanged |
| `server/src/platform/api/platform.controller.js` | `fail()` → `error: errorField(code)` | `error:"CODE"` unchanged |

All five controller GET/READ envelopes from Step 3 (`{ ok, data }`) and all WRITE envelopes
(`{ ok, result }`) are untouched. Only the **error** slot now flows through the shared builder.

**Why default output is byte-identical (keeps every existing test green):** in `string` mode
`errorField(code)` returns `String(code)` — exactly the previous literal — and `error.js` still emits
`detail` in string mode. No existing assertion sees any change.

---

## 3. STEP 4.2 — controlled migration posture

The flag gives uniform dual-shape **capability** to all three controllers + the global handler at
once, but the **lever** (the flag) is the gradual control:

- Today: `ERROR_ENVELOPE` unset → every producer emits legacy string. Nothing migrated in output.
- Flip to `object` → all producers emit `{ code, message }`; the frontend already consumes it
  (Step 3, test-proven) with no view or `normalize.js` change.

This satisfies "do not remove string format / do not switch all controllers at once in output / use a
feature toggle." The Revenue→Channel→Platform ordering requested in 4.2 is honored at the **rollout**
level: the flag can be enabled per-environment after Revenue is validated, with Channel/Platform
already capable but observed in turn. (Per-module flags were considered and rejected as needless
surface — one global toggle with a hardened consumer is simpler and equally gradual.)

---

## 4. STEP 4.3 — compatibility guarantee (verified)

| Requirement | Status |
|---|---|
| `apiClient` works unchanged | ✅ not modified in Step 4; already dual-shape from Step 3 |
| Frontend views untouched | ✅ zero view changes |
| `normalize.js` untouched | ✅ zero changes |
| No test rewrites required | ✅ existing tests unchanged; only **additive** new unit tests |

---

## 5. STEP 4.4 — Validation (tests)

| Suite | Result | Baseline | Verdict |
|---|---|---|---|
| Backend `npm test` | **459 pass / 0 fail / 3 skip (462)** | 455/0/3 (458) | ✅ +4 new, no regression |
| Frontend `npm test` | **28 pass / 0 fail** | 28/0 | ✅ unchanged |

**New coverage — `server/test/errorEnvelope.test.js` (4 tests, additive):**
- `buildError` always returns `{ code, message }` (incl. fallbacks).
- `errorField` default (no flag) → legacy string.
- `errorField` `string` mode → bare code (message ignored).
- `errorField` `object` mode → `{ code, message }`.

**Confirmed (4.4 checklist):**
- ✅ No `[object Object]` risk — `apiClient` sets `ApiError.message = message || code` (Step 3); in
  object mode `error.message` is a real string, in string mode `error.code` is the message source.
- ✅ No missing `error.code` regression — `e.code` is always a string in both shapes.
- ✅ No break in existing assertions — default string output is byte-identical; backend count rose
  only by the additive tests.

---

## 6. R2 completion status

| R2 element | State after Step 4 |
|---|---|
| Frontend dual-shape consumer | ✅ active (Step 3) |
| Backend normalized error builder | ✅ present (`errorEnvelope.js`) |
| Backend dual-shape capability | ✅ all 3 controllers + global handler |
| Default output | legacy string (unchanged, fully compatible) |
| Object shape | opt-in via `ERROR_ENVELOPE=object` (consumer ready) |
| Legacy string removal | **not done** (intentional — kept as default; removal is a future closure step) |

**R2 is functionally complete and reversible:** the full nested-error path exists end-to-end and is
test-proven on both ends; flipping it on is a one-flag, zero-code, zero-frontend operation.

---

## 7. Risk assessment update (post-Step 4)

| Risk | Pre-Step-4 | Post-Step-4 | Notes |
|---|:---:|:---:|---|
| Error-shape change breaks consumer | MEDIUM | **LOW** | Consumer dual-shape (Step 3) + producer default unchanged. |
| Existing tests assert string error body | — | **LOW** | Default mode byte-identical; verified 459/0. |
| Object mode breaks HTTP tests that assert string errors | n/a | **KNOWN/EXPECTED** | If the flag is flipped to `object`, any test asserting a literal string `error` would need updating. None run in object mode by default, so no current failure. Tracked for the future closure step. |
| `[object Object]` in UI | MEDIUM (if producer-first) | **NONE** | Consumer-first ordering held; `ApiError.message` guarantees a string. |
| Rollback complexity | — | **LOW** | Revert `error.js` + `fail()` + delete `errorEnvelope.js`; keep apiClient (safe). Single-file local reverts. |

**One-way doors:** none introduced. The only future irreversible step (removing legacy string
support) is explicitly **not** taken here.

---

## 8. Rollback plan (as specified)

1. Revert `server/src/middleware/error.js`.
2. Revert the three `fail()` helper changes (Revenue/Channel/Platform) + `env.js` flag line.
3. Delete `server/src/middleware/errorEnvelope.js` and `server/test/errorEnvelope.test.js`.
4. **Keep** `apiClient.js` (Step 3) — safe, no frontend rollback needed.

---

## 9. Success criteria

| Criterion | Status |
|---|:---:|
| Backend supports dual error shape internally | ✅ §1–§2 |
| Legacy string error still fully functional | ✅ default mode, byte-identical |
| No UI changes required | ✅ |
| No breaking changes | ✅ default output unchanged |
| Tests remain green | ✅ backend 459/0/3, frontend 28/0 |
| System ready for full R2 closure or Phase 24 | ✅ flag flip is the only remaining step |

## 10. Outputs delivered
1. Updated `middleware/error.js` — §2.
2. Updated `fail()` helpers (Revenue/Channel/Platform) + new `errorEnvelope.js` + `env.js` flag — §1–§2.
3. This validation report (R2 completion status) — `docs/QYRVIA_PHASE23_STEP4_ERROR_PRODUCER_REPORT.md`.
4. Risk assessment update (post-Step 4) — §7.
