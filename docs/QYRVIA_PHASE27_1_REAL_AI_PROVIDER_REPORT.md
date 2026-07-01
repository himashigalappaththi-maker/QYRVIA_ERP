# QYRVIA Phase 27.1 — Real AI Provider — Report

**Objective:** add a **real LLM-backed AIProvider** behind the existing AIProvider interface, with
SecretProvider-resolved credentials, single-shot + multi-turn extraction, low-confidence fallback, and
**provider swap with no agent change**. Production-capable but **default-OFF**; **no real network** is
contacted in tests/default (injected fake transport). **No vendor lock-in.**

> Like B8-B5 (real OTA HTTP), this makes the system *capable* of calling a real LLM but does **not**
> fire a real call: that needs a vendor endpoint + key + `AI_LLM_ENABLED=true`, an explicit operational
> step. No OpenAI/Claude/Gemini was contacted.

---

## 1. Architecture diagram
```
aiAgentService  (unchanged — depends only on the AIProvider interface)
   │ classifyIntent / extractEntities / generateResponse
   ▼
AIProvider  ── kind = 'mock' ─────────────► MockAIProvider (rules)            [default]
            └─ kind = 'llm'  ─────────────► LlmAiProvider
                                              ├─ resolveKey() ── SecretProvider (B8-B1) ── credentials_ref
                                              ├─ transport.chat(messages,{apiKey}) ── HttpLlmTransport
                                              │      (default DISABLED ⇒ no network; fake fetch in tests)
                                              ├─ validate(intent ∈ allowed, confidence ≥ threshold) + sanitize(slots)
                                              └─ on low-confidence / error / disabled ⇒ FALLBACK → MockAIProvider (rules)
   ▼
BookingService → commandBus → PMS → Channel Manager → OTA sync   (unchanged)
```

## 2. Provider comparison
| Aspect | MockAIProvider (default) | LlmAiProvider (27.1) |
|---|---|---|
| NLU | deterministic rules | LLM over HTTP transport, **rule fallback** |
| Network | none | only when `AI_LLM_ENABLED=true` + endpoint (fake fetch in tests) |
| Key | none | resolved via SecretProvider (`credentials_ref`) |
| Confidence | always 1 (`source:'rules'`) | `source:'llm'` if `confidence ≥ threshold`, else `source:'fallback'` |
| Vendor coupling | none | none — transport is OpenAI-compatible **and** accepts bare `{content}`; swap = config |
| Booking-critical replies | template | **template (forced)** — never LLM (no hallucinated references) |
| Agent code impact | — | **none** (same interface) |

## 3. Credential flow
```
AI_LLM_CREDENTIALS_REF ─► LlmAiProvider.resolveKey()
   └─► SecretProvider.get(credentials_ref, { tenant_id })   (AES-256-GCM at rest, B8-B1)
         └─► { api_key }  ── passed per-call as Authorization: Bearer <key>
```
- The key is **never** placed in the prompt body, **never** logged, **never** stored on the provider
  or in conversation state. (Test asserts the key is absent from the prompt messages.)
- No key / no SecretProvider ⇒ `resolveKey()` returns null ⇒ provider still works via fallback.

## 4. Safety controls
| Control | Mechanism |
|---|---|
| Default off / no accidental network | `AI_AGENT_ENABLED=false`, `AI_PROVIDER=mock`, `AI_LLM_ENABLED=false`; transport short-circuits before fetch |
| Never blocks a booking on LLM failure | low-confidence / parse-error / HTTP-error / disabled ⇒ deterministic rule fallback |
| No hallucinated references/totals | booking-critical replies (`created/updated/cancelled/collect/need_reference/rejected`) always rendered from the template, never the LLM |
| Output validation | intent must be in the allowed set + meet confidence threshold; entities sanitized to known typed slots (unknown keys dropped, `adults/children` coerced numeric) |
| Secret hygiene | key via SecretProvider; not in prompt/logs/state |
| No vendor lock-in | provider chosen by config; transport accepts generic response shapes |
| No DB mutations by AI | provider only classifies/extracts/replies; all writes remain `BookingService → commandBus` |

## 5. Files
**Created**
- `server/src/ai-agent/provider/mockProvider.js` — `AIProvider` + `MockAIProvider` + `renderReply` (split out)
- `server/src/ai-agent/provider/llmTransport.js` — HTTP LLM transport (default disabled)
- `server/src/ai-agent/provider/llmAiProvider.js` — real provider (SecretProvider + validation + fallback)
- `server/test/aiLlmProvider.test.js` — 10 tests
- `docs/QYRVIA_PHASE27_1_REAL_AI_PROVIDER_REPORT.md` — this report

**Modified**
- `server/src/ai-agent/provider/index.js` — factory now builds `llm` kind (mock default; existing exports kept)
- `server/src/ai-agent/index.js` — `buildAiAgent` accepts a pre-built provider + `providerOpts`
- `server/src/config/env.js` — `AI_LLM_ENABLED` / `AI_LLM_ENDPOINT` / `AI_LLM_MODEL` / `AI_LLM_CREDENTIALS_REF`
- `server/src/index.js` — gated DI passes SecretProvider + LLM opts when `AI_PROVIDER='llm'`

No PMS/OTA/Booking-Engine/UI/schema changes. Agent orchestration unchanged.

## 6. Test results
**Backend: 588 / 0 / 3 (591) → 598 / 0 / 3 (601)** (+10, zero regressions). Frontend untouched (28/0).

**Tests (10):** SecretProvider key resolution (key absent from prompt) · single-shot extraction
(sanitized, unknown keys dropped) · **multi-turn extraction through the agent with the LLM provider** ·
low-confidence ⇒ rule fallback · transport-error / invalid-intent ⇒ fallback · **provider swap (agent
identical with mock or llm)** · disabled HTTP transport ⇒ no fetch + fallback · booking-critical reply
is deterministic (LLM not consulted) · enabled HTTP path uses fake fetch (OpenAI-compatible, Bearer
key) · `sanitizeEntities` typing.

## 7. Regression summary
- **Zero regressions.** The Phase-27 mock provider was refactored into `mockProvider.js` and re-exported;
  all 10 Phase-27 agent tests still pass unchanged.
- **Default runtime identical:** mock provider, no LLM, no network; the LLM path is inert unless
  `AI_PROVIDER=llm` **and** `AI_LLM_ENABLED=true` **and** a key/endpoint are configured.
- PMS / OTA / Booking Engine / UI / schema: untouched.

## 8. Go-live (operational, no code change)
Set `AI_AGENT_ENABLED=true`, `AI_PROVIDER=llm`, `AI_LLM_ENDPOINT=<vendor>`, store the vendor key via the
SecretProvider and set `AI_LLM_CREDENTIALS_REF`, then `AI_LLM_ENABLED=true`. The agent and Booking
Engine are otherwise unchanged.

## 9. Rollback
- **Instant:** keep `AI_PROVIDER=mock` (or `AI_LLM_ENABLED=false`) ⇒ rule-based, no network.
- **Code:** delete `provider/{llmTransport,llmAiProvider}.js` and `test/aiLlmProvider.test.js`; revert
  `provider/index.js` to mock-only, the `ai-agent/index.js` provider params, the `env.js` LLM flags, and
  the `index.js` provider-opts block. (`mockProvider.js` can stay; it's the same code, re-exported.)

## 10. Constraints honored
✅ Provider behind the abstraction (no agent change) · ✅ Key via SecretProvider, never leaked ·
✅ Low-confidence fallback to rules · ✅ Default OFF / no real network in tests · ✅ No vendor lock-in ·
✅ No real OpenAI/Claude/Gemini call fired. **No UI/PMS/OTA/schema changes.**

**STOP after implementation & validation. Do not begin Phase 27.2 (Real WhatsApp Transport). Await
approval.**
