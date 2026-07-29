# Offline AI Agent — Sketch Plan

**Goal:** when there's no internet, the admin can still ask the AI assistant questions about tenants, payments, units, and overdue balances, answered entirely from data already synced to the device.

This is a fallback layer next to the existing cloud assistant (`askAgent` Cloud Function, Gemini → Groq → Mistral fallback chain) — not a replacement. Online stays the primary path since it's smarter and needs no on-device model download.

---

## 1. Why this is feasible here

- The app is already **local-first**: IndexedDB holds tenants, units, payments, locations via the outbox-sync pattern. That means the data an offline agent needs to answer most admin questions ("who's overdue", "how much did unit 4 pay this month") is *already on the device* — no new sync work required.
- The hard part isn't data, it's **inference without a server**. That means running a small language model directly in the browser.

## 2. Core approach

Run a small quantized LLM **in-browser via WebGPU/WASM**, using a library like **WebLLM** (MLC) or **Transformers.js** (ONNX Runtime Web) — no native install, fits the existing single-file-HTML/PWA pattern.

```
User query (offline)
   → detect no connection (navigator.onLine / failed fetch)
   → build a compact context block from IndexedDB
       (relevant tenants/units/payments — NOT the whole DB)
   → run local model with a constrained prompt template
   → parse response, render like the online assistant's chat bubble
```

### Model candidates (small enough for mobile/PWA)
| Model | Size (quantized) | Notes |
|---|---|---|
| Qwen2.5-0.5B / 1.5B-Instruct | ~0.3–1GB | Fast, decent instruction following, good default |
| Gemma 2 2B-it | ~1.5GB | Stronger reasoning, heavier download |
| Phi-3.5-mini | ~2GB | Best quality of this tier, may be too heavy for low-end Android |

Given Filipino low-/mid-range Android devices are the target, **start with the smallest (0.5B–1.5B) model** and only upgrade if quality testing demands it.

## 3. Key design decisions to work through

1. **Model delivery & caching**
   - Ship model weights via CDN, cached into the Cache API / IndexedDB on first successful online session (opt-in download, not bundled in the app — keeps initial install light).
   - Service worker serves cached weights when offline; show download progress once, "AI is ready offline" indicator after.

2. **Query scope — keep it narrow on purpose**
   - Online assistant does broad tool-calling (fuzzy name match, projections, multi-step). Offline model won't be as capable, so scope it down to a fixed set of **structured lookups**, not open-ended reasoning:
     - tenant balance / payment history lookup
     - overdue tenant list
     - unit occupancy status
     - simple income totals for a period
   - Implement these as **local "tools"** (plain JS functions over IndexedDB) that the small model chooses between via a constrained JSON-output prompt — same shape as the online tool-calling loop, just smaller and local.

3. **Context window management**
   - Small models have short, weak context handling. Don't dump the whole DB into the prompt — pre-filter with simple JS (date range, name match) *before* handing rows to the model, then let the model just phrase the answer.

4. **Fallback chain integration**
   - Extend the existing provider fallback (Gemini → Groq → Mistral) with a final rung: **local model**, triggered only when all network attempts fail or `navigator.onLine` is false.
   - Same chat UI, but tag offline answers ("Answered offline — may be less accurate") so the admin knows the difference.

5. **Sync/staleness caveat**
   - Offline answers only ever reflect what's already synced to the device via the outbox pattern. If the admin hasn't opened the app in days, offline answers may be stale — surface a "data last synced: X" note in offline mode.

## 4. Rough milestones

1. **Spike:** load WebLLM/Transformers.js in a throwaway test page, run the smallest candidate model, measure load time + inference speed on a mid-range Android phone (this determines if the whole idea is viable).
2. **Local tool set:** port a subset of the existing Cloud Function tools (tenant lookup, overdue list, unit lookup) to pure client-side JS functions over IndexedDB.
3. **Prompt template:** constrained JSON-schema prompt so the small model reliably picks a tool + args instead of free-text hallucinating.
4. **Offline detection + fallback wiring:** hook into the existing `askAgent` call path so a failed/absent connection routes to the local model instead of failing outright.
5. **Model caching UX:** one-time download flow, storage-quota checks, re-download/versioning strategy for model updates.
6. **Test on real low-end devices** — this is the biggest risk (RAM, WebGPU support gaps on older Android WebViews/TWA).

## 5. Open risks / questions

- **WebGPU support in the TWA/Play Store wrapper** — needs verification; may need a WASM-only fallback path if WebGPU isn't available in the wrapped WebView.
- **Storage budget** — a 0.5–1.5GB model download on top of app data may hit PWA storage quotas on some devices; needs a graceful "not enough space, offline AI unavailable" path.
- **Quality bar** — decide up front how wrong offline answers are allowed to be before this isn't worth shipping (e.g., is 80% accuracy on the 4 core query types acceptable?).
- **Battery/CPU cost** — inference on-device is heavier than a network call; worth testing impact on older phones during normal use.
