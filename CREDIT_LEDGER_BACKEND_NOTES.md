# UpaPro — Per-Client Credit Ledger (Firestore schema + backend pieces)

What's already done, in `index.html`, on this pass:
- `billingPlan` local state (defaults to unlimited — safe for every existing user until you actually assign plans)
- `loadBillingPlan()` — reads `users/{uid}/billing/plan`, called right after `loadRemindersSetting()` on sign-in
- Unit creation blocked client-side once `state.cache.units.length >= billingPlan.unitLimit`
- Agent Ria chat blocked client-side once `agentCreditsRemaining <= 0`, with a friendly upgrade message instead of a dead-end error
- After every `askAgent` call, the local credit count is overwritten by whatever the server hands back — the client never decrements its own number

What's **not** done, because it lives outside this file — the Cloud Function (`agent-openrouter.js` or wherever `askAgent` is defined) and your Firestore rules. Both are needed before this is actually enforced rather than just displayed.

---

## 1. Firestore schema

```
users/{uid}/billing/plan   (single doc)
{
  tier: "free" | "starter" | "pro" | "business",
  unitLimit: number | null,            // null = unlimited
  agentCreditsPerCycle: number | null, // credits granted each reset
  agentCreditsRemaining: number | null,
  cycleStart: Timestamp,
  cycleEnd: Timestamp,
  updatedAt: Timestamp
}

users/{uid}/billing/plan/creditLog/{entryId}   (subcollection, append-only audit trail)
{
  id: string,
  delta: number,        // negative for a chat debit, positive for a reset/top-up
  reason: "chat" | "cycle-reset" | "manual-adjustment" | "purchase",
  balanceAfter: number,
  createdAt: Timestamp
}
```

Why a doc rather than counting the `units` collection live: reading a cached `unitLimit`/count pair is one document read instead of a full collection scan on every check, and it's the same pattern this app already uses for `settings/reminders`.

---

## 2. Cloud Function changes (`askAgent`)

The credit check-and-decrement has to happen **inside** `askAgent`, server-side, in a transaction — the client-side check added today is just UX polish; it does nothing to stop someone from calling the function directly with modified local state.

```js
// Inside askAgent, before calling out to Groq/Mistral/Gemini:
const planRef = db.collection('users').doc(uid).collection('billing').doc('plan');

const newBalance = await db.runTransaction(async (tx) => {
  const planDoc = await tx.get(planRef);
  const plan = planDoc.exists ? planDoc.data() : null;

  // No plan doc = unlimited, same convention as the client default.
  if (!plan || plan.agentCreditsRemaining === null) return null;

  if (plan.agentCreditsRemaining <= 0) {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      'Out of Agent Ria credits for this cycle'
    );
  }

  const next = plan.agentCreditsRemaining - 1;
  tx.update(planRef, { agentCreditsRemaining: next });
  tx.set(planRef.collection('creditLog').doc(), {
    delta: -1,
    reason: 'chat',
    balanceAfter: next,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return next;
});

// ...after the LLM call succeeds, include it in the response:
return { reply, creditsRemaining: newBalance };
```

The client already reads `result.data.creditsRemaining` and `err.code === 'functions/resource-exhausted'` — both match this shape, so no client-side changes are needed once this lands.

---

## 3. Firestore security rules

Two things to lock down:

**a) Clients must never write their own `billing/plan` doc directly** — only Cloud Functions (via the Admin SDK, which bypasses rules) should ever change `agentCreditsRemaining` or `unitLimit`. Read-only from the client:

```
match /users/{uid}/billing/plan {
  allow read: if request.auth != null && request.auth.uid == uid;
  allow write: if false; // Admin SDK (Cloud Functions) only
}
match /users/{uid}/billing/plan/creditLog/{entryId} {
  allow read: if request.auth != null && request.auth.uid == uid;
  allow write: if false;
}
```

**b) Enforce the unit limit at the rules layer too** — the client-side check in `index.html` is enough to stop the *normal app UI* from over-creating, but rules are what stop a modified/replayed request from bypassing it:

```
match /users/{uid}/units/{unitId} {
  allow create: if request.auth != null && request.auth.uid == uid
    && (
      !exists(/databases/$(database)/documents/users/$(uid)/billing/plan)
      || get(/databases/$(database)/documents/users/$(uid)/billing/plan).data.unitLimit == null
      || get(/databases/$(database)/documents/users/$(uid)/billing/plan).data.unitLimit > resource.size // approximate — see note below
    );
}
```
Note: Firestore rules can't cheaply count a collection's documents. The common workaround is to keep a maintained `unitsUsed` counter *on the plan doc itself* (incremented/decremented in the same transaction as unit create/delete, similar to the credit pattern above) and compare against that counter instead of trying to count the collection in the rule.

---

## 4. Cycle resets

Whatever grants `agentCreditsPerCycle` back to `agentCreditsRemaining` on a schedule (monthly, matching a subscription billing cycle) should be a scheduled Cloud Function, the same pattern already used for `rentReminders.js` — reads every `billing/plan` doc where `cycleEnd <= now`, resets `agentCreditsRemaining = agentCreditsPerCycle`, advances `cycleStart`/`cycleEnd`, and logs a `cycle-reset` entry.
