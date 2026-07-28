# UpaPro AI Agent — Option B Migration Plan
### Manual multi-provider fallback: Gemini → Groq → Mistral (all free tier)

Reference doc — check items off as you go. Safe to close and come back to.

**2026-07-28 update:** Cerebras has been fully swapped out for **Mistral** — see
"Where we are right now" and Issues #17–#20 below for the full story (Cerebras's free-tier
model catalog shifted twice in one sitting: `llama-3.3-70b` was removed, its replacement
`gpt-oss-120b` needed payment, and the only remaining free model had a tight 5 req/min cap —
Mistral was the more stable long-term pick). All references to Cerebras below the "2026-07-28
update" line are historical — kept for the record, not reflecting the current chain.

---

## Why this exists

Currently deployed: switching from **Option A (OpenRouter)** to **Option B (manual multi-provider)**,
using `agent-manual-fallback.js`, calling Gemini, Groq, and Cerebras directly — no OpenRouter
middleman.

**Fallback order:** Gemini → Groq → Mistral — all free tier, no card required (in principle;
see gotchas below, Gemini needed a billing link to actually get real free-tier quota; Cerebras
was tried in the Mistral slot first but dropped — see Issues #17–#19).

**What does NOT change:** `index.html` stays exactly as-is. It calls
`firebase.functions().httpsCallable('askAgent')` — it doesn't know or care which provider is
behind that function.

---

## 📍 Where we are right now (updated 2026-07-28)

**The multi-provider chain is fully working and confirmed end-to-end.** All three providers —
Gemini, Groq, Mistral — have been individually verified on plain text generation, a no-argument
tool call (`getOverdueTenants`), and a tool call with real arguments (`getTenantByUnit`). This
closes out everything section 7 and 8 of the checklist were waiting on.

**How each provider was verified:** a new standalone callable, `testAgentProvider`, was added
specifically for this (see Issue #21). It calls one named provider directly — bypassing
`PROVIDER_CHAIN`'s ordering entirely — so any provider can be spot-checked from the browser
console without editing `PROVIDER_CHAIN` and redeploying twice per test, which is how the first
few rounds of testing were done before this existed. Two modes:
- `{ provider: 'groq' }` — plain greeting prompt, no tools. Fast connectivity/auth check.
- `{ provider: 'groq', mode: 'tool', testPrompt: '...' }` — runs a real tool-call round-trip
  through `executeTool()`, scoped to the calling admin's own data. `testPrompt` lets you target
  any specific tool by phrasing the prompt to trigger it (defaults to the
  `getOverdueTenants` prompt if omitted). A safety guard blocks `sendPaymentReminder`
  specifically from actually executing during a test — it has real side effects (messages an
  actual tenant) — returning `blocked: "..."` instead, so test prompts can be phrased loosely
  without risk of spamming a real tenant.

**Confirmed via `testAgentProvider`:**
- Gemini, Groq, Mistral all correctly fire `getOverdueTenants` (no-arg tool) and produce a
  correct final answer from real data.
- Gemini, Groq, Mistral all correctly fire `getTenantByUnit` with correctly-shaped
  multi-argument input (`unitLabel`, `locationName`) — this is the specific shape that
  originally tripped up Groq (see Issue #18) with a malformed, non-JSON tool call.

**Fixed along the way, now permanent:**
- `askAgent()`'s fallback logic now moves to the next provider on **any** error, not just 429
  rate limits (see Issue #19) — previously a single malformed-tool-call error (Groq's 400
  `tool_use_failed`) killed the entire request even with two healthy providers still available
  in the chain.
- Cerebras replaced with Mistral as the third provider (`callMistral`, `mistral-small-latest`,
  `MISTRAL_API_KEY` secret) — see Issues #17–#19 for why.

**Confirmed working from before, still true:**
- **Issue #10 — real tenant names.** Confirmed against real data.
- **Issue #11 / #13 — "did you mean X?" suggestions.** Confirmed firing correctly.
- **Broad-request tools** — `getAllTenants`, `getOverdueTenants`, `getPayments`, and
  `getMonthlyIncome` are confirmed working.

**Still deployed but not specifically re-tested (unchanged from before this update):**
- Issue #9's compound/chained tool-call loop — no compound request has been specifically
  re-tested since the loop fix deployed.
- Issue #12's `matchedTenant` zero-payment-history fix — not yet re-confirmed against a real
  zero-payment tenant.
- The units/locations tool set (`getTenantByUnit` is now confirmed via `testAgentProvider`
  above; `getVacantUnits`, `getOccupiedUnits`, `getExpectedIncome` are still untested).
- Two-admin isolation test — still not done.
- Only `getOverdueTenants` and `getTenantByUnit` have been exercised through
  `testAgentProvider`'s tool mode so far. The remaining tools (`getTenantPaymentStatus`,
  `getVacantUnits`, `getOccupiedUnits`, `getExpectedIncome`, `getAllTenants`, `getPayments`,
  `getMonthlyIncome`, `getMaintenanceRequests`) share simpler shapes (no args, or a single
  well-typed arg) closer to what's already verified, so risk is lower, but they haven't been
  individually spot-checked provider-by-provider.

**Deliberately still deferred:** `getUnitByNumber` (covered by `getTenantByUnit` for the "who's in
unit X" case), `getDashboardStats`, `getAllUnits` — no concrete need yet for their specific shape.

**Deliberately still deferred:** `getUnitByNumber` (covered by `getTenantByUnit` for the "who's in
unit X" case), `getDashboardStats`, `getAllUnits` — no concrete need yet for their specific shape.

---


## Checklist

### 1. Get API keys
- [x] Gemini API key — aistudio.google.com
- [x] Groq API key — console.groq.com
- [x] ~~Cerebras API key — cloud.cerebras.ai~~ obtained, used, then dropped — see Issues
      #17–#19 (model deprecated, replacement gated behind payment, remaining free model too
      rate-limited to trust as a fallback link)
- [x] Mistral API key — console.mistral.ai (no card required) — replaces Cerebras, see Issue #19

### 2. Store keys as Firebase secrets
- [x] `GEMINI_API_KEY` set (currently on version 2 — regenerated after the billing-link fix)
- [x] `GROQ_API_KEY` set
- [x] ~~`CEREBRAS_API_KEY` set~~ no longer used in the deployed chain
- [x] `MISTRAL_API_KEY` set — replaces `CEREBRAS_API_KEY` in both `askAgent` and
      `testAgentProvider`'s secrets list

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
      rather than guessing at a top-level collection. **Deployed** 2026-07-26 (see Issue #8 scoping fix).
- [x] **Fallback now moves to the next provider on ANY error, not just 429s** (see Issue #19) —
      previously a plain error (e.g. Groq's 400 `tool_use_failed`) killed the whole request
      instead of trying the next provider in the chain. **Deployed** 2026-07-28.
- [x] **Cerebras adapter (`callCerebras`) replaced with `callMistral`** — `mistral-small-latest`
      via Mistral's OpenAI-compatible endpoint, reusing the existing `buildOpenAIMessages()` /
      `normalizeOpenAIResponse()` helpers (same shape as Groq, smallest possible adapter change).
      `CEREBRAS_KEY`/`CEREBRAS_API_KEY` references renamed to `MISTRAL_KEY`/`MISTRAL_API_KEY`
      throughout. **Deployed** 2026-07-28 (see Issue #19).
- [x] **Added `testAgentProvider(providerName, adminUid, mode, testPrompt)`** — calls one named
      provider directly, bypassing `PROVIDER_CHAIN` entirely. `mode: 'greeting'` (default) is a
      plain no-tools connectivity check; `mode: 'tool'` runs a real tool-call round-trip through
      `executeTool()`, with `testPrompt` selecting which tool gets exercised. Includes a safety
      guard that blocks `sendPaymentReminder` from actually executing during a test. **Deployed**
      2026-07-28 (see Issue #21).

### 4. Swap the Cloud Function over
- [x] `functions/index.js` imports from `./agent-manual-fallback`
- [x] `secrets` array updated to `["GEMINI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY"]`
      (originally `CEREBRAS_API_KEY` — swapped 2026-07-28, see Issue #19)
- [x] Function still exported as `exports.askAgent` — `index.html` untouched
- [x] **Added auth verification** (see Issue #8): `index.js` now throws `unauthenticated` if
      `request.auth` is missing, and independently checks `admins/{adminUid}` exists before
      proceeding — mirrors the rules file's own admin-gating logic, since the Admin SDK doesn't
      enforce `firestore.rules` for server-side code. Passes the verified `adminUid` into
      `askAgent(message, [], adminUid)`. **Deployed** 2026-07-26.
- [x] **New export: `exports.testAgentProvider`** — same admin-gated pattern as
      `exports.askAgent`/`exports.testRentDueReminders`, `secrets: ["GEMINI_API_KEY",
      "GROQ_API_KEY", "MISTRAL_API_KEY"]`. Accepts `{ provider, mode, testPrompt }` and forwards
      to `testAgentProvider()` in `agent-manual-fallback.js`. **Deployed** 2026-07-28.

### 5. (Optional) Add graceful exhaustion handling
- [ ] Not yet wired in — holding off until the base 3-provider chain is confirmed working first

### 6. Deploy
- [x] Deployed multiple times while debugging (currently on revision `askagent-00016-wob`)
- [x] **Deploy the multi-admin scoping fix** (`index.js` + `agent-manual-fallback.js` as of
      Issue #8) — pushed 2026-07-26 ~00:09 UTC.
- [ ] **Test with both admin accounts** — logs so far only show one admin's session; still need
      to sign in as the second landlord and confirm isolation, plus confirm a non-admin caller
      gets a clean `permission-denied`.
- [x] **Deploy the Issue #9 tool-loop fix** — deployed. Not yet specifically re-tested with a
      compound request.
- [ ] **Re-test a compound request** (e.g. "list open maintenance requests, then check payment
      status for unit 301") to confirm the loop returns real text instead of a raw toolCalls array.
- [x] **Deploy Issues #10–#15** (real tenant names, matchedTenant fix, token-level suggestion tier,
      `getAllTenants`, expanded getter set) and the new units/locations tool set (`getTenantByUnit`,
      `getVacantUnits`, `getOccupiedUnits`, `getExpectedIncome`) — all deployed. #10, #11/#13, and
      the broad-request getters (`getAllTenants`/`getOverdueTenants`/`getPayments`/
      `getMonthlyIncome`) are confirmed working in testing; #9's loop, #12's matchedTenant fix, and
      most of the units/locations tools are still deployed but not specifically re-tested
      (`getTenantByUnit` is now the exception — confirmed via `testAgentProvider`, see below).
- [x] **Ran into a stale-deploy issue while testing the PROVIDER_CHAIN reorder** — `firebase
      deploy` reported success and the deployed file was confirmed correct via a temporary
      `console.log` marker, but early test rounds kept showing Gemini-only logs. Root cause
      turned out to be simply testing before the new deploy had actually rolled out / before a
      genuinely new test message was sent, not a caching or build-pipeline bug — worth
      remembering next time a deploy "doesn't seem to take": confirm timestamps on both the
      deploy and the test message line up before assuming the file itself is wrong.
- [x] **Deployed `testAgentProvider`** (`exports.testAgentProvider` in `index.js` +
      `testAgentProvider()` in `agent-manual-fallback.js`) — see Issue #21. Used to confirm all
      three providers individually without reordering `PROVIDER_CHAIN`.
- [x] **Deployed the Cerebras → Mistral swap** — see Issue #19.

### 7. Test each provider individually
- [x] Gemini — **confirmed working end-to-end**, including real tool-calling via
      `testAgentProvider` (both `getOverdueTenants` and `getTenantByUnit`).
- [x] Groq — **confirmed working**, including real tool-calling. One real bug found and fixed
      along the way (see Issue #18): a first attempt at `getTenantByUnit` came back malformed
      (`tool_use_failed`, 400) — Groq's model rendered the call as literal text instead of a
      structured tool call, including hallucinating `"locationName": "null"` as a string. Re-ran
      via `testAgentProvider` after the fallback-on-any-error fix (Issue #19) and it succeeded
      cleanly. Worth keeping an eye on with more complex multi-arg tools going forward, but the
      connection/key/model itself is solid.
- [x] ~~Cerebras~~ dropped — see Issues #17–#19. Replaced by:
- [x] Mistral — **confirmed working**, including real tool-calling via `testAgentProvider`
      (both `getOverdueTenants` and `getTenantByUnit`).

### 8. Test the fallback itself
- [x] All three providers confirmed individually reachable and working via `testAgentProvider`
      (bypasses `PROVIDER_CHAIN` ordering by design — calls one named provider directly).
- [ ] Not yet tested: an actual **live fallback event** in production — i.e. Gemini genuinely
      failing/rate-limiting during a real `askAgent` call and Groq or Mistral picking up
      automatically. Every real production test so far has been answered by Gemini (first in the
      chain) before ever reaching the others. `testAgentProvider` proves each link works in
      isolation, not that the chain hands off correctly under a real failure — worth simulating
      at some point (e.g. temporarily using a bad Gemini key) if that confidence matters before
      relying on it in a real outage.

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
   returns a plain apology string instead of silence). **Deployed, not yet specifically re-tested** with a compound/chained request.
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
    suggestion until the admin confirms. **Deployed and confirmed working** — depended on Issue #10's
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
    from behavior. **Deployed, not yet specifically re-tested** against a zero-payment-history match.
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
    ("Rachelle Bitualla") still resolves as `fuzzy` as before. **Deployed and confirmed working.**
14. **No tool existed to list all tenants** — asking "give me the list of all tenants I have" got
    a polite "I don't have a tool for that" from the model, which was correct: there wasn't one.
    **Fixed**: added a new `listTenants` tool (no params) alongside the existing two. It reuses
    `getTenantCandidates()` rather than a separate query, so it stays in sync with
    `resolveTenantLabel()`'s field-name fallback for free. Deliberately filters out candidates
    with `hasName: false` (the raw-doc-ID fallback used internally for fuzzy-scoring unnamed
    legacy docs) so the admin-facing list never shows a bare Firestore ID as if it were a tenant
    name — instead returns a `note` field naming how many such records were left out.
    `SYSTEM_PROMPT` and the tool's own description were both updated so the model knows to reach
    for it on broad "show me everyone" asks, not just specific-name lookups. **Deployed and confirmed
    working.**
15. **Expanded the tool set from a proposed getter list, deduped, and renamed to match.** The
    proposed list (`getAllTenants`, `getTenantByName`, `getOverdueTenants`, `getPayments`,
    `getMonthlyIncome`, `getMaintenanceRequests`, plus several unit/location/dashboard getters)
    had duplicate entries and assumed data (units, locations, contracts, utility bills, occupancy)
    that isn't confirmed to exist anywhere in the real schema — only `tenants`, `payments`, and
    `maintenanceRequests` are confirmed (see Issue #8). **Deliberately deferred**: `getUnitByNumber`,
    `getVacantUnits`, `getOccupiedUnits`, `getDashboardStats`, `getAllUnits`, `getExpectedIncome` —
    none added yet, pending a Firestore console check to confirm whether a units/locations
    collection actually exists and what it's shaped like. Guessing here risked either a thrown
    error or, worse, a tool that silently returns "zero vacant units" for a feature that was never
    wired up. **Implemented now** (all backed by the confirmed schema): renamed `listTenants` →
    `getAllTenants` and `listOpenMaintenanceRequests` → `getMaintenanceRequests` to match the
    requested convention; added `getTenantByName` (identity-only lookup, reuses `resolveTenant()`
    without querying payments), `getOverdueTenants` (latest payment per tenant, filtered to
    `status: "overdue"`, joined against tenant labels via `getTenantCandidates()`), `getPayments`
    (raw payment list, optional `status` filter), and `getMonthlyIncome` (sum of `status: "paid"`
    payments dated in the current calendar month — explicitly does NOT report an "expected"
    figure, since that needs a rent/lease amount with no confirmed data source yet).
    `SYSTEM_PROMPT` updated to: reference the renamed tools, add Peso (₱) formatting and
    Philippine date-format conventions (pulled from the admin's proposed prompt), and explicitly
    tell the model to say "I don't have enough information to answer that yet" for any
    unit/location/occupancy/expected-income question rather than inferring or estimating from
    tenant/payment data. **Deployed.** `getAllTenants`, `getOverdueTenants`, `getPayments`, and
    `getMonthlyIncome` are confirmed working in testing; the renamed `getTenantByName` and
    `getMaintenanceRequests` haven't been specifically re-tested under their new names.

16. **New scope, not in the original plan: units/locations.** A Firestore console check confirmed
    `units` and `locations` are real collections under `users/{adminUid}/` (`units`: `unitLabel`,
    `locationId`, `status`, `monthlyRent`, `dueDay`, electricity/water billing rate fields;
    `locations`: `name`, `address`). Four new tools were added on top of the original getter list:
    `getTenantByUnit` (who's linked to a unit, optionally scoped to a property name, with
    candidate-listing when a unit label or property name is ambiguous), `getVacantUnits` /
    `getOccupiedUnits` (plain occupancy lists), and `getExpectedIncome` (sum of `monthlyRent`
    across occupied units — a projection, explicitly distinct from `getMonthlyIncome`'s actual-
    collected figure). `SYSTEM_PROMPT` updated accordingly. Deliberately still not added:
    `getUnitByNumber` (covered by `getTenantByUnit`), `getDashboardStats`, `getAllUnits` — no
    concrete need yet. **Deployed** — `getTenantByUnit` is now confirmed working (see Issue #21);
    `getVacantUnits`, `getOccupiedUnits`, `getExpectedIncome` still untested.
17. **Cerebras's `llama-3.3-70b` no longer exists on the account's key.** Testing Cerebras
    directly via `testAgentProvider` (added for this purpose, see Issue #21) returned
    `model_not_found` (404) — despite `llama-3.3-70b` matching Cerebras's own public docs at the
    time. Ran `GET /v1/models` against the real key to get a ground-truth answer instead of
    trusting docs that could be stale: the account's actual available models were
    `zai-glm-4.7`, `gpt-oss-120b`, `gemma-4-31b` — no Llama models at all anymore.
18. **`gpt-oss-120b` (the natural first pick from #17) needed payment.** Switched the Cerebras
    adapter to `gpt-oss-120b` on the reasoning that an OpenAI-family model would have the most
    reliable tool-calling of the three available — but `testAgentProvider` immediately returned
    `402 payment_required`, meaning this model is gated behind a paid plan on this account even
    though it appeared in the free key's own model list. Switched to `gemma-4-31b` instead, which
    the admin separately confirmed is listed under Cerebras's Free Trial tier (5 req/min, 30k
    input tokens/min, 1M tokens/day) — worked, but see Issue #19 for why this still didn't end
    up as the final choice.
19. **Cerebras dropped entirely in favor of Mistral, after two model-catalog surprises in one
    sitting (#17, #18).** Even with `gemma-4-31b` working, the free tier's 5 requests/minute cap
    is tight enough that a single chained tool-calling exchange (this agent allows up to
    `MAX_TOOL_ROUNDS = 5`) could plausibly exhaust it on its own — combined with two consecutive
    model-availability surprises on the same key in the same session, Cerebras's free tier felt
    too volatile to trust as a fallback link, even a last-resort one. **Decision: swapped for
    Mistral** — `callCerebras` replaced with `callMistral` (`mistral-small-latest`, via Mistral's
    OpenAI-compatible `/v1/chat/completions` endpoint, same `buildOpenAIMessages()` /
    `normalizeOpenAIResponse()` helpers already used for Groq — smallest possible adapter diff).
    `CEREBRAS_KEY`/`CEREBRAS_API_KEY` renamed to `MISTRAL_KEY`/`MISTRAL_API_KEY` throughout both
    `agent-manual-fallback.js` and `index.js`. **Deployed and confirmed working** — see Issue #21.
    Separately, this surfaced a real independent bug in the fallback logic itself while testing
    Groq (Issue #18's investigation): `askAgent()`'s `catch` block only continued to the next
    provider on `err.rateLimited` (a 429) — any *other* error (like Groq's 400 `tool_use_failed`,
    see Issue #20) was rethrown and killed the entire request, even with two healthy providers
    left in the chain. **Fixed**: the catch block now logs and continues to the next provider on
    any failure, not just rate limits. This is a real resilience improvement independent of the
    Cerebras/Mistral swap — kept permanently.
20. **Groq returned a malformed tool call for `getTenantByUnit`.** First real multi-argument
    tool-calling test against Groq (`testPrompt: "Who is in unit X at [property]?"`, before
    `testPrompt` existed as a parameter — done by manually testing in the app) came back
    `400 tool_use_failed`: `llama-3.3-70b-versatile` rendered the call as literal
    `<function=getTenantByUnit{...}>` text instead of a structured tool call, and hallucinated
    `"locationName": "null"` as a string rather than omitting the optional field. This request
    would previously have died outright (see Issue #19's fallback fix) — after that fix deployed,
    the same test re-run via `testAgentProvider` succeeded cleanly. Not treated as disqualifying
    for Groq (single test failure, worked on retest) but worth watching if this recurs on other
    multi-argument tools.
21. **Added `testAgentProvider` to make provider-by-provider testing sane.** Every test up to
    this point required manually reordering `PROVIDER_CHAIN` and deploying twice (once to move a
    provider to the front, once to revert) just to exercise a provider other than Gemini — slow,
    error-prone, and part of why the stale-deploy confusion in section 6 happened at all.
    **Fixed**: new `testAgentProvider(providerName, adminUid, mode, testPrompt)` in
    `agent-manual-fallback.js`, exposed via a new admin-gated callable `exports.testAgentProvider`
    in `index.js` (same pattern as `exports.testRentDueReminders`). Calls one named provider
    directly, bypassing `PROVIDER_CHAIN` ordering entirely — no redeploying needed to test a
    different provider going forward. `mode: 'tool'` runs a full tool-call round-trip through the
    real `executeTool()`, scoped to the calling admin's own data, with `testPrompt` selecting
    which tool gets exercised (defaults to a `getOverdueTenants`-triggering prompt). Includes a
    safety guard: if a test prompt happens to make a provider call `sendPaymentReminder` (the one
    tool with real side effects — it messages an actual tenant), the test path returns
    `blocked: "..."` instead of executing it for real. **Deployed and confirmed working** — used
    to verify Gemini, Groq, and Mistral all correctly handle both `getOverdueTenants` (no-arg)
    and `getTenantByUnit` (multi-arg) tool calls.

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
- **Response shapes differ across providers** — Groq and Mistral both mirror OpenAI's format
  closely, Gemini's is the most different and needs its own `normalizeGeminiResponse()`.
- **Free-tier model catalogs can shift without warning, even mid-session.** Cerebras's
  `llama-3.3-70b` (matching its own public docs) had already been removed from the account's
  actual model list by the time this was tested; the natural next pick (`gpt-oss-120b`) turned
  out to be gated behind a paid plan despite showing up in the free key's `/v1/models` response.
  Don't trust a provider's marketing page or even general docs for which models are actually
  callable on a given key — hit `GET /v1/models` (or that provider's equivalent) with the real
  key and read from that response directly.
- **A successful `firebase deploy` doesn't guarantee the code change you expect is live** — spent
  real time debugging what looked like a stale deploy (reordering `PROVIDER_CHAIN`, deploying,
  testing, seeing old behavior) that turned out to just be testing against a message sent before
  the new revision had actually rolled out. A loud temporary `console.log` marker at the top of
  the function, confirmed present in a fresh log line, is the fastest way to rule this out before
  assuming the deploy itself failed silently.
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
