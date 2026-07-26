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

- **Multi-admin scoping fix: deployed** (revision `askagent-00016-wob`, 2026-07-26 ~00:09 UTC) —
  no longer just written, it's live. Re-tested against Gemini afterward: the "Rachell Bitualla"
  lookup still correctly returns "no tenant found" (expected — she's not a UpaPro tenant, so
  this confirms the scoped query path works, not a regression).
- **New bug found in that same post-deploy test session — Issue #9: tool-call loop only ran
  once.** A compound ask ("list open maintenance requests" → model then chained into checking
  payment status for unit "301") needs two sequential tool round-trips. The old code only did
  one call → tool → follow-up call and returned whatever came back — even if that follow-up
  response was itself another `functionCall`. The last log line ends exactly there: a second
  `getTenantPaymentStatus` functionCall for `"301"` came back as the "final" result, which has
  no `.text`, so the client would have silently received `{ reply: undefined }`. **Fixed in
  code** — `askAgent()` now loops (`while`, capped at `MAX_TOOL_ROUNDS = 5`) instead of doing a
  single round-trip. **Not yet deployed or tested.**
- **Gemini: working end-to-end** for single-tool-call requests, including name-based tenant
  lookup with typo tolerance. Multi-tool-call chains were broken until the Issue #9 fix above —
  need to re-test those specifically once deployed.
- **Groq, Cerebras: still untested** — every real test so far has been answered by Gemini
  before the chain reached them.
- One open question flagged in gotchas: whether `users/{adminUid}/tenants/{tenantId}` docs
  actually have a `name` field — worth a quick console check.
- **New addition — Issue #11: added a "suggestion" middle tier to `resolveTenant()`.** Failed
  lookups used to be a flat "no tenant found" with zero information even when a genuinely close
  candidate existed just outside the auto-use fuzzy threshold. Now the nearest candidate gets
  checked against a looser threshold and surfaced as `suggestedTenant` so the admin gets "did you
  mean X?" instead. **Code written, not yet deployed or tested** — and won't be meaningful until
  Issue #10's real-name fix is deployed, since suggestions need real labels, not raw doc IDs.
- Still outstanding from before: **test with both admin accounts** specifically to confirm
  cross-tenant isolation — the logs so far only show one admin's session.

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
- [x] Deployed multiple times while debugging (currently on revision `askagent-00016-wob`)
- [x] **Deploy the multi-admin scoping fix** (`index.js` + `agent-manual-fallback.js` as of
      Issue #8) — pushed 2026-07-26 ~00:09 UTC.
- [ ] **Test with both admin accounts** — logs so far only show one admin's session; still need
      to sign in as the second landlord and confirm isolation, plus confirm a non-admin caller
      gets a clean `permission-denied`.
- [ ] **Deploy the Issue #9 tool-loop fix** (`agent-manual-fallback.js` — `askAgent()` now loops
      over tool rounds instead of doing one round-trip) — written, not yet pushed.
- [ ] **Re-test a compound request** after that deploy (e.g. "list open maintenance requests,
      then check payment status for unit 301") to confirm it now returns real text instead of a
      raw toolCalls array.

### 7. Test each provider individually
- [x] Gemini — **confirmed working end-to-end** for the original flat-collection queries.
      Full round trip verified: initial tool call → tool executed → follow-up call → real text
      answer back, with `toolCalls: []` on the final result. Took several rounds of fixes to get
      here (quota-limit-0, deprecated model name, two multi-turn tool-calling format issues —
      Issues #5/#6 — plus the array-response fix in Issue #7). Name-based fuzzy tenant lookup
      also confirmed working for the "no match found" case. **Re-confirmed working post-scoping-
      deploy for single-tool-call requests** — but that same test session surfaced Issue #9
      (compound/chained tool calls weren't handled). Needs one more re-test once the Issue #9
      fix is deployed.
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
   flat legacy data existed. **Fixed and deployed** — see section 6.
9. **Tool-call loop only handled one round-trip** — found right after the Issue #8 deploy, when
   a request chained two tool calls in sequence (list maintenance requests, then look up payment
   status for a specific unit). `askAgent()` only ever called the provider once, ran the tool
   once, called the provider a second time, and returned that second response unconditionally —
   even when that second response was itself another `functionCall` instead of final text. The
   caller got `result.text === undefined` with no error thrown, so `index.js` would return
   `{ reply: undefined }` to the app with nothing visibly wrong in the logs (the last log line
   just shows a second `functionCall` sitting there as the "FINAL RESULT"). **Fixed**: the
   single `if` block is now a `while` loop capped at `MAX_TOOL_ROUNDS = 5`, so it keeps feeding
   tool results back until the model returns real text (or the cap is hit, in which case it
   returns a plain apology string instead of silence). **Not yet deployed.**
10. **Tenant docs don't have a `name` field — confirmed, not just suspected.** Admin A's real
    debug logs show `getTenantCandidates()` returning labels like `"id_mruew5ln90g2ie"` for a
    query of `"Rachell Bitualla"` even though that admin genuinely has tenants named "Rachelle
    Bitualla" and "Richard Eugenio" on file. The fallback `d.data().name || d.id` was silently
    resolving to the raw Firestore doc ID for every candidate, so every fuzzy comparison was
    matching a real name against a meaningless ID string (distance 16-17) instead of against
    "Rachelle Bitualla" (which would've scored a distance-1 near-miss, well inside the fuzzy
    threshold — the matching *algorithm* was never the problem). **Fixed**: `getTenantCandidates()`
    now tries `name`, `fullName`, `tenantName`, `displayName`, then `firstName`+`lastName`, in
    that order via a new `resolveTenantLabel()` helper, and logs a loud console warning naming
    which doc ID lacks a usable field instead of silently falling back to it. `resolveTenant()`
    also now excludes any candidate with no resolvable name from fuzzy scoring entirely, so a
    handful of un-named legacy docs can't crowd out or interfere with real matches. **Not yet
    deployed** — still need the actual Firestore console check to confirm which field name(s)
    are really in use, so the right one ends up first in the fallback chain (right now `name` is
    still tried first on the original assumption; reorder once confirmed).
11. **No middle tier between "confident fuzzy match" and "no tenant found"** — flagged while
    reviewing a real failed lookup ("Rachelle Bitualla" / "Rachelle") that returned a flat
    "double-check the spelling or provide a unit number" with zero information, even though a
    genuinely close candidate may exist just outside the auto-use threshold. **Fixed**:
    `resolveTenant()` now has a third path — when nothing clears the existing fuzzy threshold, it
    checks the single nearest candidate against a looser `suggestThreshold`
    (`max(threshold + 2, queryLength * 0.45)`) and returns `{ type: "suggestion", matches: [nearest] }`
    instead of an unconditional `"none"`. `executeTool()` surfaces this as a `suggestedTenant`
    field alongside the existing `error` string (kept separate from `wasExactMatch: false`, which
    already ran the lookup — a suggestion has NOT been looked up). `SYSTEM_PROMPT` now tells the
    model to ask "did you mean X?" and explicitly not to look up or state payment details for the
    suggestion until the admin confirms. **Not yet deployed or tested** — depends on Issue #10's
    real-name fix being deployed first, since `getTenantCandidates()` needs actual name labels
    (not raw doc IDs) for this suggestion to be meaningful.
12. **A resolved fuzzy match with zero payment history was indistinguishable from "tenant not
    found."** Found via real logs from testing #11: querying "Rachelle Bitualla" against real
    tenant "Rachell Bitualla" correctly scored `distance: 1` and resolved as a fuzzy match — the
    matching logic worked. But `getTenantPaymentStatus`'s `payments.empty` branch returned only
    `{ error: "No payment records found for this tenant" }` with no `matchedTenant` field at all.
    With no way to know the name had actually resolved, the model retried with a shortened name
    ("Rachelle" alone, distance 9, genuinely no match), then folded both dead ends into one "couldn't
    find a tenant matching either name" reply — silently losing a real match. **Fixed**: the empty-
    payments branch now returns `matchedTenant` and `wasExactMatch` alongside the error, and
    `SYSTEM_PROMPT` now explicitly says a `matchedTenant` field means the name search succeeded
    (even alongside an error) and the model should not retry with a different spelling once it has
    one. Also added a debug log line logging whether the payments query was empty and for which
    resolved tenant, to directly confirm this against real data next test instead of inferring it
    from behavior. **Not yet deployed or tested.**
13. **Suggestion tier never fired for a bare first-name query, even a near-perfect one.** Real
    test: querying "Rachelle" (or "Rachell") against real tenant "Rachell Bitualla" returned a
    flat "couldn't find a tenant" with no suggestion, despite "Rachell" being a distance-0/1 match
    to her first name. Root cause: `resolveTenant()` only ever scored the query against the FULL
    label ("rachell bitualla") — a bare first name is naturally far in edit distance from a
    two-word label (distance 9 in this case) no matter how exact a match it is to the first name
    alone, so neither the fuzzy nor the suggestion threshold could ever catch it. **Fixed**: each
    candidate is now also scored against its individual name tokens (`tokenDistance`, split on
    whitespace) alongside the existing full-label `distance`. A close token match never auto-
    resolves (matching one word doesn't confirm full identity) but now feeds the suggestion tier
    via a new `tokenThreshold`, checked after the existing full-label fuzzy/ambiguous logic and
    before the final full-label suggestion fallback. Verified against real data from this test:
    "Rachelle" and "Rachell" against "Rachell Bitualla" both now resolve to `type: "suggestion"`
    (tokenDistance 1 and 0 respectively) instead of "none," while the existing full-name-typo case
    ("Rachelle Bitualla") still resolves as `fuzzy` as before. **Not yet deployed or tested.**

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
