# QYRVIA Phase 27.1A — Multi-Provider AI Foundation (Anthropic Default) — Report

**Objective:** replace the generic `AI_PROVIDER=llm` architecture with an enterprise multi-provider AI
framework (Anthropic, OpenAI, Gemini, Mock) with automatic failover — while preserving the AI agent's
behavior and keeping runtime **OFF by default**. **No real network in tests; baseline 598/0/3 stays
green; Mock remains fully functional.**

---

## 1. Architecture diagram
```
aiAgentService  (UNCHANGED — depends only on the AIProvider interface)
   │ classifyIntent / extractEntities / generateResponse
   ▼
ProviderFailoverChain  (IS an AIProvider)
   ├─ AnthropicProvider ─┐
   ├─ OpenAIProvider     ├─ each: SecretProvider key (exec-time) → vendor HTTP transport (default DISABLED)
   ├─ GeminiProvider    ─┘        → validate(intent/confidence) + sanitize(slots); on ANY failure → throw Unavailable
   └─ MockProvider  (GUARANTEED final fallback — rules, never throws, no network)
   ▼
BookingService → commandBus → PMS → Channel Manager → OTA sync   (UNCHANGED)

Failover order (config):  AI_PROVIDER → AI_FALLBACK_PROVIDER → AI_TERTIARY_PROVIDER → Mock
Default:                   anthropic   → openai               → gemini               → mock
```

## 2. Provider comparison matrix
| | Mock | Anthropic | OpenAI | Gemini |
|---|---|---|---|---|
| API | rules | Claude Messages API | Chat Completions | generateContent |
| Auth header | — | `x-api-key` | `Authorization: Bearer` | `x-goog-api-key` (header, not URL) |
| Default transport | n/a | **disabled** | **disabled** | **disabled** |
| Network in tests/default | none | none | none | none |
| Key source | none | SecretProvider | SecretProvider | SecretProvider |
| On failure | n/a (never fails) | throw → next | throw → next | throw → next |
| Hospitality default | fallback | guest convo, reservation extraction, copilot | forecasting, analytics | marketing content |
| Agent code impact | — | none | none | none |

## 3. Failover design
- `ProviderFailoverChain` tries providers in order; a provider that **throws `ProviderUnavailable`**
  (disabled / HTTP error / low confidence / invalid output) or returns nothing is skipped; the next is
  tried. **Mock is appended last** and never throws, so a result is always produced — automatic,
  no agent change.
- Booking-critical replies (`created/updated/cancelled/collect/need_reference/rejected`) are rendered
  **deterministically by Mock** regardless of provider (no hallucinated references/totals).
- Default boot: vendor transports disabled ⇒ every vendor throws ⇒ **chain resolves to Mock** with
  **zero network**. So enabling `AI_PROVIDER=anthropic` alone changes nothing until vendor HTTP +
  keys + endpoints are configured.

## 4. Credential flow
```
AI_LLM_CREDENTIALS_REF ─► provider.resolveKey()  (execution time only)
   └─► SecretProvider.get(credentials_ref, { tenant_id })   (AES-256-GCM at rest, B8-B1)
         └─► { api_key } ── per-call vendor auth header (x-api-key / Bearer / x-goog-api-key)
```
Reuses **SecretProvider**, **CredentialAuthStrategy** model, and **`channel_credential_store`**. The
key is resolved per call, **never** in config files, prompt bodies, logs, or conversation state.

## 5. Security controls
| Control | Mechanism |
|---|---|
| OFF by default | `AI_AGENT_ENABLED=false`; vendor transports disabled (`AI_LLM_ENABLED=false`) ⇒ Mock, no network |
| No secret leakage | key via SecretProvider, passed as auth header only; test asserts key absent from prompt; Gemini key in header (not URL) |
| No hallucinated bookings | booking-critical replies are deterministic (Mock), never the LLM |
| Output validation | intent ∈ allowed set + confidence ≥ threshold; entities sanitized to known typed slots |
| Always-available | Mock is the guaranteed terminal fallback (never throws) |
| No AI DB mutations | providers only classify/extract/reply; writes stay `BookingService → commandBus` |
| No vendor lock-in | factory selects by config; transports are per-vendor adapters; agent unchanged |

## 6. Files
**Created** (`server/src/ai-agent/providers/`): `AIProvider.js` (base + shared vendor engine),
`AnthropicProvider.js`, `OpenAIProvider.js`, `GeminiProvider.js`, `MockProvider.js`,
`ProviderFailoverChain.js`, `ProviderFactory.js`; plus `server/test/aiMultiProvider.test.js` and this
report.
**Modified:** `ai-agent/index.js` (`buildAiAgent` → `buildAgentProvider` chain); `config/env.js`
(`AI_PROVIDER=anthropic` default + `AI_FALLBACK_PROVIDER=openai` + `AI_TERTIARY_PROVIDER=gemini`);
`index.js` (DI passes SecretProvider + vendor opts).
**Retained for backward-compat:** Phase-27.1 `provider/{llm*,mockProvider}.js` (the 27.1 tests still
import them); the agent no longer uses the generic `llm` kind.

## 7. Test results
**Backend: 598 / 0 / 3 (601) → 607 / 0 / 3 (610)** (+9, zero regressions). All Phase 27 (10) and
Phase 27.1 (10) AI tests still pass unchanged. Frontend untouched (28/0).

**New tests (9):** Anthropic/OpenAI/Gemini registration · factory selection (+ `llm` rejected) ·
failover chain (down → next) · all-vendors-down → Mock · SecretProvider key + no-leakage · **agent
identical across mock / chain** · default chain makes no network call · config validation + hospitality
routing policy · enabled Anthropic transport via injected fetch (x-api-key, no real network).

## 8. Regression summary
- **Zero regressions;** 598 baseline preserved → 607. Mock provider fully functional and is the chain's
  guaranteed fallback. Default runtime identical (no agent built unless enabled; chain → Mock; no network).
- PMS / Booking Engine / OTA / UI / schema / WhatsApp: **untouched.** No outbound calls in tests.

## 9. Operational activation guide
1. Store each vendor key via the SecretProvider (B8-B1); note the `credentials_ref`.
2. Set `AI_LLM_CREDENTIALS_REF`, `AI_LLM_ENDPOINT` (+ `AI_LLM_MODEL`) and `AI_LLM_ENABLED=true`.
3. Choose order: `AI_PROVIDER` / `AI_FALLBACK_PROVIDER` / `AI_TERTIARY_PROVIDER` (default
   anthropic/openai/gemini); `validateConfig` rejects unknown kinds.
4. Set `AI_AGENT_ENABLED=true`. The agent and Booking Engine are otherwise unchanged.
> (Per-vendor endpoints/refs are passed as one `providerOpts` set in this foundation; per-vendor
> distinct endpoints are a small future refinement.)

## 10. Rollback
- **Instant:** `AI_PROVIDER=mock` **or** disable all provider flags (`AI_LLM_ENABLED=false` /
  `AI_AGENT_ENABLED=false`) ⇒ deterministic Mock, no network. **No code removal required.**

## 11. Constraints honored
✅ Report-first · ✅ No PMS / Booking Engine / OTA / UI / schema / WhatsApp changes · ✅ No outbound
calls in tests · ✅ 598 baseline green · ✅ Mock fully functional · ✅ No generic `llm` provider ·
✅ Automatic failover, no agent change · ✅ Secrets resolved at execution time only.

**STOP after implementation & validation. Do NOT begin Phase 27.2 (WhatsApp Transport) / CRM /
Revenue Forecasting / AI Copilot. Await approval.**
