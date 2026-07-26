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

## 📍 Where we are right now

- **Gemini: working end-to-end**, including name-based tenant lookup with typo tolerance.
- **Multi-admin data scoping: just fixed in code, NOT yet deployed or tested.** This was a
  significant find (see Issue #8) — `executeTool()` was querying flat, unscoped Firestore
  collections with no concept of which of the 2 admin accounts was asking. `index.js` and
  `agent-manual-fallback.js` have both been rewritten to scope every query to
  `users/{adminUid}/...` and to verify the caller against `admins/{adminUid}` before running
  anything. **Next step: deploy this and test with both landlord accounts before doing anything
  else** — this should take priority over Groq/Cerebras testing below, since it affects whether
  Gemini's already-working responses are even reading the right admin's data.
- **Groq, Cerebras: still untested** — every real test so far has been answered by Gemini
  before the chain reached them.
- One open question flagged in gotchas: whether `users/{adminUid}/tenants/{tenantId}` docs
  actually have a `name` field — worth a quick console check.

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
- [x] Reworked message history into a neutral shape (`toolCalls`/`toolCallId` carried through)
      with per-provider builders (`buildGeminiContents`, `buildOpenAIMessages`) so tool call IDs
      and the assistant's own tool-call turn are properly replayed on the follow-up request —
      fixes the infinite tool-call loop (see Issue #5)
- [x] Fixed Gemini function-response role: this API rejects role `"function"` outright —
      function responses now sent under role `"user"` instead (see Issue #5)
- [x] Fixed Gemini `thought_signature` requirement: `normalizeGeminiResponse()` now captures
      `thoughtSignature` off each `functionCall` part and `buildGeminiContents()` echoes it back
      verbatim on the follow-up call (see Issue #6)
- [x] Rewrote the system prompt (`SYSTEM_PROMPT` constant) with real domain knowledge: payment/
      maintenance status vocabulary, and explicit instructions for how to react to each tenant-
      lookup outcome (exact, fuzzy, ambiguous, none) — replaces the original one-line prompt
- [x] Replaced ID-based tenant lookup with name-based fuzzy matching: `getTenantPaymentStatus`
      now takes `tenantName`, resolved via a Levenshtein-distance match (`resolveTenant()` /
      `getTenantCandidates()`) against real tenant records, tolerating small typos and
      distinguishing "no match," "one fuzzy match," and "multiple ambiguous matches" — see
      Issue #7's "no tenant found" case, confirmed working in testing
- [x] Fixed Gemini 400 on `listOpenMaintenanceRequests`: `functionResponse.response` must be a
      JSON object, not an array — added `wrapAsObject()` to wrap array/primitive tool results
      before they're sent back (see Issue #7)
- [x] **Multi-admin data scoping fix** (see Issue #8): `executeTool()`, `getTenantCandidates()`,
      and `resolveTenant()` now all require and use `adminUid`, scoping every Firestore query to
      `users/{adminUid}/...` per the real `firestore.rules` schema, instead of querying flat
      unscoped collections. `getTenantCandidates()` also now reads from the real
      `users/{adminUid}/tenants` subcollection first (confirmed to exist by the rules file)
      rather than guessing at a top-level collection. **Not yet deployed/tested.**

### 4. Swap the Cloud Function over
- [x] `functions/index.js` imports from `./agent-manual-fallback`
- [x] `secrets` array updated to `["GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY"]`
- [x] Function still exported as `exports.askAgent` — `index.html` untouched
- [x] **Added auth verification** (see Issue #8): `index.js` now throws `unauthenticated` if
      `request.auth` is missing, and independently checks `admins/{adminUid}` exists before
      proceeding — mirrors the rules file's own admin-gating logic, since the Admin SDK doesn't
      enforce `firestore.rules` for server-side code. Passes the verified `adminUid` into
      `askAgent(message, [], adminUid)`. **Not yet deployed.**

### 5. (Optional) Add graceful exhaustion handling
- [ ] Not yet wired in — holding off until the base 3-provider chain is confirmed working first

### 6. Deploy
- [x] Deployed multiple times while debugging (currently on revision `askagent-00007-rid`)
- [ ] **Deploy the multi-admin scoping fix** (`index.js` + `agent-manual-fallback.js` as of
      Issue #8) — written but not yet pushed. `firebase deploy --only functions:askAgent` from
      the project root once both files are copied into `functions/`.
- [ ] **Test with both admin accounts** after that deploy — sign in as each landlord, confirm
      each only ever sees their own tenants/payments/maintenance requests, and confirm a non-
      admin caller gets a clean `permission-denied` rather than either silent failure or someone
      else's data.

### 7. Test each provider individually
- [x] Gemini — **confirmed working end-to-end** for the original flat-collection queries.
      Full round trip verified: initial tool call → tool executed → follow-up call → real text
      answer back, with `toolCalls: []` on the final result. Took several rounds of fixes to get
      here (quota-limit-0, deprecated model name, two multi-turn tool-calling format issues —
      Issues #5/#6 — plus the array-response fix in Issue #7). Name-based fuzzy tenant lookup
      also confirmed working for the "no match found" case. **Needs re-confirming after the
      multi-admin scoping deploy above**, since queries now point at a different Firestore path.
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
5. **Gemini looped, calling the same tool twice instead of answering after the tool result** →
   **Fixed**: two compounding bugs. (a) Neither normalizer preserved the tool call's `id`, so
   nothing could match a result back to the call that requested it. (b) The follow-up request
   never re-inserted the assistant's own tool-call turn into history, so Gemini had no record it
   had already asked for the tool — every retry looked like a fresh question. Then hit a second
   wall fixing this: Gemini's API rejects role `"function"` outright (`400: Role 'function' is
   not supported`) — function responses had to go under role `"user"` instead.
6. **Gemini 400: "Function call is missing a thought_signature in functionCall parts"** →
   **Fixed**: Gemini 3.5 requires the `thoughtSignature` that came back alongside the original
   `functionCall` to be echoed back verbatim when replaying that turn in a follow-up request.
   Wasn't being captured at all before — added to both the response normalizer and the
   content-builder.
7. **Tenant name matching + Gemini's array-response rejection**, found together while testing
   `getTenantPaymentStatus("Rachell Bitualla")`: (a) name-based fuzzy matching was added
   (`resolveTenant()`, Levenshtein distance) since admins search by name, not tenant ID — the
   "no match found" path was confirmed working, giving a clean "double-check the spelling" reply
   instead of a false "no payment history" implication. (b) Separately, `listOpenMaintenanceRequests`
   then hit a new Gemini 400 — `functionResponse.response` must be a JSON object, not an array
   ("Proto field is not repeating, cannot start list") — fixed with a `wrapAsObject()` helper.
8. **Multi-admin data scoping was completely missing** — found while reviewing `firestore.rules`
   for an unrelated reason (checking why a fuzzy name match wasn't resolving) and realizing the
   real data schema is `users/{adminUid}/{store}/{docId}`, not the flat top-level collections
   `executeTool()` was actually querying. Two compounding issues: (a) `index.js` never passed
   `request.auth.uid` into `askAgent()` at all, and never verified the caller was a genuine
   linked admin — both `firestore.rules` checks that the Admin SDK doesn't enforce server-side.
   (b) Every Firestore query in `agent-manual-fallback.js` was unscoped, so with 2 real admin
   accounts now live, the agent had no way to tell them apart — at best returning nothing (if
   real data only exists nested under each admin), at worst mixing data across landlords if any
   flat legacy data existed. **Fixed in code, not yet deployed** — see section 6.

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
- **Gemini's multi-turn tool-calling format has sharp edges beyond the basic request/response
  shape** — a working single-turn call doesn't mean multi-turn (tool call → tool result →
  final answer) will work out of the box. Two gotchas specific to this API version: function
  responses must be sent under role `"user"`, not `"function"` as the docs might suggest; and
  every replayed `functionCall` part must carry back the exact `thoughtSignature` Gemini
  originally returned with it, or the follow-up request is rejected. Both are one-line fixes
  once you know they're needed, but the error messages are the only way to discover them.
- **`tenantId` lookups were ID-based, not name-based** — during Gemini testing, a request for
  "Rachell Bitualla" came back with no payment records found, because `getTenantPaymentStatus`
  originally expected an actual tenant ID, not a display name. **Fixed** — see Issue #7; the
  tool now takes a name and fuzzy-matches it.
- **The Admin SDK does not enforce `firestore.rules`** — anything running with `firebase-admin`
  (i.e. any Cloud Function using `admin.firestore()`) reads and writes with full server
  privileges. All the careful per-admin scoping and tenant-portal carve-outs in `firestore.rules`
  only apply to client-side reads/writes from the browser/portal — a Cloud Function has to
  reimplement any access control it needs (adminUid scoping, admin-account verification) in its
  own code. This is what Issue #8 was — worth remembering for any *future* Cloud Function too,
  not just this one.
- **`users/{adminUid}/tenants/{tenantId}` field names aren't fully confirmed** — the rules file
  confirms the collection exists and lists its tenant-writable fields (`documents`,
  `leaseSignature`, `portalUid`, `portalEmail`), but doesn't mention a `name` field explicitly.
  `getTenantCandidates()` assumes `doc.data().name` holds the tenant's display name — worth a
  quick console check to confirm that's actually the field in use.
