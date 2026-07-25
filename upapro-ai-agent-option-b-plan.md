# UpaPro AI Agent — Option B Migration Plan
### Manual multi-provider fallback: Gemini → Groq → Cerebras (all free tier)

Reference doc — check items off as you go. Safe to close and come back to.

---

## Why this exists

Currently deployed: switching from **Option A (OpenRouter)** to **Option B (manual multi-provider)**,
using `agent-manual-fallback.js`, calling Gemini, Groq, and Cerebras directly — no OpenRouter
middleman.

**Fallback order:** Gemini → Groq → Cerebras — all free tier, no card required (in principle;
see gotchas below, Gemini needed a billing link to actually get real free-tier quota).

**What does NOT change:** `index.html` stays exactly as-is. It calls
`firebase.functions().httpsCallable('askAgent')` — it doesn't know or care which provider is
behind that function.

---

## Checklist

### 1. Get API keys
- [x] Gemini API key — aistudio.google.com
- [x] Groq API key — console.groq.com
- [x] Cerebras API key — cloud.cerebras.ai

### 2. Store keys as Firebase secrets
- [x] `GEMINI_API_KEY` set (currently on version 2 — regenerated after the billing-link fix)
- [x] `GROQ_API_KEY` set
- [x] `CEREBRAS_API_KEY` set

### 3. Update `agent-manual-fallback.js`
- [x] Reordered `PROVIDER_CHAIN` to: **Gemini, Groq, Cerebras**
- [x] `executeTool()` filled in (`getTenantPaymentStatus`, `listOpenMaintenanceRequests`)
- [x] `admin`/`db` added at the top
- [x] `normalizeGeminiResponse()` checked against a real response — confirmed correct shape once
      Gemini actually returned data (see gotchas: needed a working model name first)
- [x] Added `res.ok` checking + raw error body logging to all three adapters (Gemini, Groq,
      Cerebras) — this wasn't in the original plan, added after Groq crashed on an unhandled
      non-429 error
- [x] Fixed `getTenantPaymentStatus` Firestore query to sort in JS instead of using `.orderBy()`,
      avoiding a composite index requirement
- [x] Updated Gemini model name from `gemini-2.0-flash` (deprecated by Google) to
      `gemini-3.5-flash-lite` (current GA low-cost model)

### 4. Swap the Cloud Function over
- [x] `functions/index.js` imports from `./agent-manual-fallback`
- [x] `secrets` array updated to `["GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY"]`
- [x] Function still exported as `exports.askAgent` — `index.html` untouched

### 5. (Optional) Add graceful exhaustion handling
- [ ] Not yet wired in — holding off until the base 3-provider chain is confirmed working first

### 6. Deploy
- [x] Deployed multiple times while debugging (currently on revision `askagent-00007-rid`)

### 7. Test each provider individually
- [ ] Gemini — **in progress**. Fixed two blockers so far: quota-limit-0 (needed Cloud Billing
      linked to the project) and deprecated model name (`gemini-2.0-flash` → `gemini-3.5-flash-lite`).
      Not yet confirmed working end-to-end with the new model name — awaiting next test.
- [ ] Groq — **in progress**. Crashed once on an unhandled error (the real reason was hidden
      because the code didn't check `res.ok`). Debug logging now added; awaiting next test to see
      the actual error body.
- [ ] Cerebras — **not yet reached**. Gemini and Groq have both failed before the chain got to
      Cerebras in every test so far.

### 8. Test the fallback itself
- [ ] Not yet reached — need at least one provider fully confirmed working first

### 9. Clean up Option A (only once B is confirmed working)
- [ ] Not started

---

## Issues found during real testing (running log)

1. **Firestore composite index error** on `getTenantPaymentStatus` (`where` + `orderBy` together
   needs a manually-created index) → **Fixed**: query now sorts in JavaScript instead.
2. **Gemini quota showing `limit: 0`** on the free tier → **Fixed**: this happens when the
   project isn't verified; linking a Cloud Billing account (still $0 unless you exceed the free
   usage allowance) moves the project to the real free quota bucket. Required regenerating the
   API key afterward (now on secret version 2).
3. **Gemini 404: `gemini-2.0-flash` no longer available** → **Fixed** (pending confirmation):
   Google deprecated this model; code now points to `gemini-3.5-flash-lite`.
4. **Groq crashed with `Cannot read properties of undefined (reading '0')`** → **Fixed** (pending
   confirmation): the adapter assumed every response was a success and tried to read
   `data.choices[0]` even when Groq returned an error object instead. All three adapters now
   check `res.ok` first and log the raw error body before parsing.

## Known gotchas to watch for

- **Gemini's free tier isn't automatically usable** — a "Free Tier" bucket with a genuine 0
  request limit exists separately from the real "Free Usage Allowance," which only activates
  once billing is linked to the project. Budget a few minutes for this step even though the
  end state is still $0 cost under normal usage.
- **Model names deprecate over time** — `gemini-2.0-flash` is already gone as of this project.
  Worth periodically checking Google's model list rather than assuming a model name stays valid
  indefinitely.
- **Always check `res.ok` / status codes before parsing a response as success** — assuming the
  shape of a successful response and reading straight into it (e.g. `data.choices[0]`) turns any
  provider-side error into a confusing crash instead of a readable message.
- **Response shapes differ across providers** — Groq and Cerebras both mirror OpenAI's format
  closely, Gemini's is the most different and needs its own `normalizeGeminiResponse()`.
- **Free tier numbers and model names change without much notice** — worth a periodic dashboard
  check on all three providers, not treated as fixed forever.
- **All three providers may use your prompts for training/improvement on the free tier** —
  standard tradeoff for genuinely free, no-card access. Worth being mindful of if tenant/payment
  data ever ends up in a prompt — keep prompts to the minimum needed (IDs and derived summaries,
  not full raw records) where possible.
