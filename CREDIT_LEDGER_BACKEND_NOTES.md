# UpaPro — Per-Client Credit Ledger (Firestore schema + backend pieces)

What's already done, in `index.html`, on this pass:
- `billingPlan` local state (defaults to unlimited — safe for every existing user until you actually assign plans)
- `loadBillingPlan()` — reads `users/{uid}/billing/plan`, called right after `loadRemindersSetting()` on sign-in
- New property (location) creation blocked once `state.cache.locations.length >= billingPlan.propertyLimit`
- Unit creation blocked once `state.cache.units.length >= billingPlan.unitLimit`
- Editing an existing property or unit is never blocked — only creating new ones
- Agent Ria chat blocked client-side once `agentCreditsRemaining <= 0`, with a friendly upgrade message instead of a dead-end error
- After every `askAgent` call, the local credit count is overwritten by whatever the server hands back — the client never decrements its own number

What's **not** done, because it lives outside this file — the Cloud Function (`agent-openrouter.js` or wherever `askAgent` is defined) and your Firestore rules. Both are needed before this is actually enforced rather than just displayed.

---

## 1. Firestore schema

```
users/{uid}/billing/plan   (single doc)
{
  tier: "free" | "starter" | "basic" | "pro" | "business",
  propertyLimit: number | null,        // null = unlimited (Business)
  unitLimit: number | null,
  agentCreditsPerCycle: number | null,
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

### Plan tier values (from the pricing table)

| Tier | Monthly price | propertyLimit | unitLimit | agentCreditsPerCycle |
|---|---|---|---|---|
| Free | ₱0 | 1 | 3 | 15 |
| Starter | ₱399 | 2 | 10 | 50 |
| Basic | ₱699 | 5 | 30 | 100 |
| Pro | ₱999 | 10 | 100 | 200 |
| Business | ₱1,599 | null (unlimited) | 300 | 500 |

Monthly price isn't a field on the plan doc itself — it's whatever your subscription/billing flow charges to land someone on a given tier. The plan doc only stores the *resulting* limits, not the price that produced them, so this table is really just the reference you (or a Cloud Function that provisions a plan on successful payment) read from when deciding what `propertyLimit`/`unitLimit`/`agentCreditsPerCycle` to write for a given tier.

A small constant map like this in the provisioning Cloud Function keeps the five tiers in one place instead of scattered magic numbers:
```js
const PLAN_CATALOG = {
  free:     { propertyLimit: 1,    unitLimit: 3,   agentCreditsPerCycle: 15  },
  starter:  { propertyLimit: 2,    unitLimit: 10,  agentCreditsPerCycle: 50  },
  basic:    { propertyLimit: 5,    unitLimit: 30,  agentCreditsPerCycle: 100 },
  pro:      { propertyLimit: 10,   unitLimit: 100, agentCreditsPerCycle: 200 },
  business: { propertyLimit: null, unitLimit: 300, agentCreditsPerCycle: 500 },
};
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
Note: Firestore rules can't cheaply count a collection's documents. The common workaround is to keep maintained `unitsUsed`/`propertiesUsed` counters *on the plan doc itself* (incremented/decremented in the same transaction as create/delete, similar to the credit pattern above) and compare against those counters instead of trying to count the collections in the rule. The client-side checks added to `index.html` (`unitLimitReached()` / `propertyLimitReached()`) cover the normal app UI today; this rules-layer version is the harder-to-bypass follow-up, for both units and properties.

---

## 4. Cycle resets

Whatever grants `agentCreditsPerCycle` back to `agentCreditsRemaining` on a schedule (monthly, matching a subscription billing cycle) should be a scheduled Cloud Function, the same pattern already used for `rentReminders.js` — reads every `billing/plan` doc where `cycleEnd <= now`, resets `agentCreditsRemaining = agentCreditsPerCycle`, advances `cycleStart`/`cycleEnd`, and logs a `cycle-reset` entry.
