/**
 * UpaPro AI Agent — Manual multi-provider approach
 * --------------------------------------------------
 * Calls Gemini, Groq, and Cerebras directly. No middleman, no markup —
 * all three are genuinely free tier, no credit card required.
 * Each provider needs its own request/response adapter because their
 * tool-calling formats differ (Groq and Cerebras are OpenAI-compatible,
 * Gemini is not).
 *
 * MESSAGE HISTORY SHAPE (neutral, provider-agnostic):
 *   { role: "system" | "user", content: string }
 *   { role: "assistant", content: string|null, toolCalls?: [{ id, name, arguments }] }
 *   { role: "tool", toolCallId: string, name: string, content: string }
 *
 * Each adapter converts this neutral history into its own wire format
 * right before the request. This is what was missing before: the old
 * code appended a bare `{ role: "tool", content }` with no call ID and
 * never re-inserted the assistant's original tool-call turn, so neither
 * Gemini nor the OpenAI-compatible providers could match a result back
 * to the call that requested it.
 *
 * TEMPORARY DEBUG: every adapter logs the raw response body when the
 * request isn't successful, and askAgent() now logs the final result
 * right before returning it, so you can see exactly what's being sent
 * back to the app. Safe to remove once everything is confirmed working.
 *
 * MULTI-TENANT ADMIN SCOPING: askAgent() and executeTool() both require
 * an adminUid, and every Firestore query goes through users/{adminUid}/...
 * — matching the real schema in firestore.rules. The Admin SDK used here
 * bypasses those rules entirely, so this scoping is enforced in code, not
 * by Firestore. adminUid must come from the caller's verified auth (see
 * index.js's admins/{adminUid} check) — never from client input.
 */

const admin = require("firebase-admin");
const db = admin.firestore();

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;

const SYSTEM_PROMPT = `You are the UpaPro admin assistant, used by property managers running boarding-house/rental operations. You help them check tenant payment status, overdue balances, income collected, and open maintenance requests.

Data model:
- A payment record's "status" reflects payment CONFIRMATION only — e.g. "paid" once accepted (tenant-portal submissions can be "pending" before confirmation). It is never "overdue" — whether a tenant is overdue is calculated from their unit's due day and payment history (via getOverdueTenants/getTenantPaymentStatus), not read off any stored field.
- Maintenance status values: "open" (not yet started), "in_progress" (being worked on). Urgency is a plain descriptive field (e.g. low/medium/high), not a fixed enum you should re-derive.
- Money is in Philippine Peso — format amounts with ₱ (e.g. ₱4,500). Dates should be shown in a Philippine date format (day month year, e.g. 26 July 2026).
- Units and locations (properties) exist in the data source: each unit has a label (e.g. "301"), belongs to a location/property (e.g. "Caloocan"), and has a status (occupied/vacant) and a monthlyRent. Use getTenantByUnit for "who is in unit X" / "who is in [property] unit X", getVacantUnits / getOccupiedUnits for broad occupancy requests, and getExpectedIncome for projected income based on occupied units' rent (distinct from getMonthlyIncome, which is what's actually been collected). There is still no data source for lease contracts or utility bills — if asked about those, say plainly: "I don't have enough information to answer that yet." Don't estimate or infer them.

Unit lookups (getTenantByUnit) are matched by unit label and, optionally, a location/property name. React to what the tool returns:
- If the result includes a "tenants" array, those are the tenant(s) currently linked to that unit — if it's empty, say plainly that no tenant is currently linked to that unit (don't imply the unit itself doesn't exist).
- If the result is an error naming multiple "candidates" (either several locations matching the name given, or the same unit label existing at more than one property), list those back to the admin and ask which one they meant. Don't pick one yourself.
- If the result is a "no unit found" or "no location found" error, say so plainly and ask the admin to double-check the unit number or property name.

getVacantUnits and getOccupiedUnits return a plain list — if either comes back empty, say so plainly (e.g. "No vacant units right now") rather than treating it as an error. getExpectedIncome is a projection, not a collected total — always describe it as expected/projected, never phrase it the way you'd phrase getMonthlyIncome's actual figure.

You can list all tenants on file with getAllTenants — use it whenever the admin asks to see everyone, how many tenants they have, or similar broad requests. If that result includes a "note" field, mention it briefly (some records have no name on file and were left out of the list) rather than ignoring it or explaining the underlying cause. getOverdueTenants and getPayments work the same way for their respective broad requests — no tenant name needed. getVacantUnits and getOccupiedUnits work the same way for occupancy requests — no unit label needed.

Tenant lookups (getTenantPaymentStatus, getTenantByName) are matched by name, not by an exact system ID, and small typos are tolerated automatically. Pass through whatever name the admin gives, even if the spelling looks slightly off — don't correct it yourself first. React to what the tool returns:
- If the result includes "wasExactMatch: false", a close-but-imperfect match was used — briefly confirm which tenant you're showing before answering (e.g. "Showing results for Rachel Bituala — let me know if that's not who you meant.").
- If the result includes a "matchedTenant" field, the name search succeeded — even if the same result also carries an "error" about missing payment records. Treat this as "found the tenant, no payment history on file," never as "couldn't find the tenant." Once you have a matchedTenant, do not call the tool again with a shortened or different spelling of the same name — you already have your answer.
- If the result is an error naming multiple close matches ("candidates"), list those names back to the admin and ask which one they meant. Don't pick one yourself.
- If the result includes a "suggestedTenant" field, no match was confident enough to use automatically — this is different from "wasExactMatch: false" above, where the tool already ran with a close match. Here, ask the admin directly, e.g. "I didn't find an exact match for [query] — did you mean [suggestedTenant]?" Do not treat the suggestion as if it were the answer, and do not look up or state any payment details for it until the admin confirms.
- If the result is a "no tenant found" error with no "suggestedTenant" field, say so plainly and ask the admin to double-check the spelling or give a unit number instead. Don't imply the tenant has no payment history — the name just didn't match anyone.

Formatting:
- When an answer has more than one item (a tenant list, overdue list, payment list, etc.), put each item on its own line using markdown — e.g. a numbered or bulleted list — never run them together in one paragraph separated only by spaces. Use an actual newline before the list starts and between each item.
- A short lead-in sentence (e.g. "You have **2** tenants in your Caloocan property:") followed by the list on its own separate lines is the expected shape. Example:

You have **2** tenants in your Caloocan property:
1. **Rachell Bitualla** (Unit 301)
2. **Richard Eugenio** (Unit 302)

- A single-item or single-fact answer (e.g. one tenant's balance) doesn't need a list — plain sentence(s) are fine.
- Keep asides or caveats (e.g. noting a tenant excluded from a location count) as a separate short line after the list, not appended to the last item.

Behavior:
- Never invent tenant names, amounts, dates, statuses, unit numbers, or occupancy figures. If a tool result is missing a field, or the data doesn't exist at all, say so rather than filling in a plausible-sounding value.
- Be concise. Admins are checking this between other tasks, not having a conversation.
- You have no visibility into anything outside what the tools return — don't reference dates, tenants, or requests you haven't looked up in this conversation.`;

// Tool schema defined once in a neutral shape; each adapter converts it
// into the format that provider expects.
//
// NOTE: units/locations ARE confirmed collections under users/{adminUid}/
// (verified directly in the Firestore console — units: unitLabel,
// locationId, status, monthlyRent, dueDay, electricityBilling/Rate,
// waterBilling/Rate; locations: name, address). getTenantByUnit,
// getVacantUnits, getOccupiedUnits, and getExpectedIncome all use this.
// getExpectedIncome sums monthlyRent across occupied units only — it's a
// projection, distinct from getMonthlyIncome's actual-collected figure.
// Still deliberately NOT included: getUnitByNumber (getTenantByUnit
// already covers "who's in unit X"; a bare unit-details lookup with no
// tenant join hasn't been asked for), getDashboardStats, getAllUnits —
// add these once there's a concrete need for their specific shape.
const toolDefs = [
  {
    name: "getTenantPaymentStatus",
    description:
      "Look up a tenant's rent status by name: whether they're overdue, how many consecutive " +
      "months, and the total balance owed — calculated from their unit's due day and payment " +
      "history (not a stored status field). Small typos in the name are tolerated — pass " +
      "whatever the admin gave, even if the spelling might be slightly off.",
    params: { tenantName: "string" },
  },
  {
    name: "getTenantByName",
    description:
      "Look up whether a tenant exists by name, without pulling payment details. Use this for " +
      "'is there a tenant named X' or 'do I have a tenant called X' — for payment status, use " +
      "getTenantPaymentStatus instead, which already includes name resolution.",
    params: { tenantName: "string" },
  },
  {
    name: "getTenantByUnit",
    description:
      "Look up which tenant(s) occupy a specific unit, by unit label and optionally a location/property " +
      "name (e.g. unitLabel: '301', locationName: 'Caloocan'). Use this for 'who is in unit X' or 'who " +
      "lives in [property] unit X' — for looking up a tenant by name instead, use getTenantPaymentStatus " +
      "or getTenantByName.",
    params: { unitLabel: "string", locationName: "string (optional)" },
  },
  {
    name: "getVacantUnits",
    description: "List all units currently marked vacant, with their location/property and monthly rent.",
    params: {},
  },
  {
    name: "getOccupiedUnits",
    description:
      "List all units currently marked occupied, with their location/property, monthly rent, and the " +
      "tenant name(s) linked to each unit.",
    params: {},
  },
  {
    name: "getExpectedIncome",
    description:
      "Total expected monthly income — the sum of monthlyRent across all currently occupied units. This " +
      "is a projection based on unit records, not what's actually been collected — for actual collections " +
      "use getMonthlyIncome instead.",
    params: {},
  },
  {
    name: "getAllTenants",
    description:
      "List all tenants on file for this admin, by name. Use this when the admin asks to " +
      "see all tenants, how many they have, or similar broad requests — not for looking up " +
      "one specific tenant.",
    params: {},
  },
  {
    name: "getOverdueTenants",
    description:
      "List all tenants currently behind on rent — calculated month-by-month from each unit's " +
      "due day against payment history, not a stored status field — with consecutive months " +
      "overdue and total balance owed for each.",
    params: {},
  },
  {
    name: "getPayments",
    description:
      "List raw payment records, most recent first. The optional status filter is a payment " +
      "CONFIRMATION state (e.g. \"paid\"), not whether a tenant is overdue — for that, use " +
      "getOverdueTenants or getTenantPaymentStatus instead.",
    params: { status: "string (optional, e.g. paid)" },
  },
  {
    name: "getMonthlyIncome",
    description:
      "Total amount actually collected (status: paid) so far in the current calendar month. " +
      "Does not include expected/projected rent — there's no confirmed data source for that yet.",
    params: {},
  },
  {
    name: "getMaintenanceRequests",
    description: "List maintenance requests still open or in_progress",
    params: { olderThanDays: "number (optional)" },
  },
];

// ---------- Gemini adapter ----------
// Gemini's tool-calling format and message roles differ from OpenAI's —
// this is the adapter work you don't get for free. Gemini needs:
//   - the model's own function-call turn preserved (role "model", a
//     functionCall part) before it will accept a function response
//   - the function response itself as a separate turn. Despite the
//     Gemini docs describing a "function" role for this, this API
//     rejects it outright (400: "Role 'function' is not supported") —
//     it wants the functionResponse part under role "user" instead.
function buildGeminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        contents.push({
          role: "model",
          parts: m.toolCalls.map((tc) => ({
            functionCall: {
              name: tc.name,
              args: JSON.parse(tc.arguments || "{}"),
              id: tc.id,
            },
            // Gemini 3.5 rejects a replayed functionCall part that's
            // missing the thoughtSignature it originally returned
            // alongside it (400: "Function call is missing a
            // thought_signature"). Must be echoed back verbatim.
            ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
          })),
        });
      } else {
        contents.push({ role: "model", parts: [{ text: m.content || "" }] });
      }
      continue;
    }

    if (m.role === "tool") {
      // This API rejects role "function" outright (400: "Role 'function'
      // is not supported"). Function responses go under role "user" instead.
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.name,
              id: m.toolCallId,
              // Gemini's functionResponse.response field must be a JSON
              // object, not an array (400: "Proto field is not
              // repeating, cannot start list") — getMaintenanceRequests
              // returns an array, so non-object results get wrapped.
              response: wrapAsObject(safeParse(m.content)),
            },
          },
        ],
      });
      continue;
    }

    // user
    contents.push({ role: "user", parts: [{ text: m.content }] });
  }
  return contents;
}

async function callGemini(messages) {
  const contents = buildGeminiContents(messages);

  // buildGeminiContents() correctly skips role:"system" out of `contents`
  // (Gemini doesn't accept a "system" role turn there) — but nothing ever
  // put it anywhere else either. Gemini's REST API takes the system
  // prompt via a separate top-level `systemInstruction` field; without
  // this, SYSTEM_PROMPT (data-model rules, tenant-matching behavior,
  // formatting) was being silently dropped on every single call.
  const systemMessage = messages.find((m) => m.role === "system");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(systemMessage ? { systemInstruction: { parts: [{ text: systemMessage.content }] } } : {}),
        contents,
        tools: [
          {
            functionDeclarations: toolDefs.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: { type: "object", properties: paramsToSchema(t.params) },
            })),
          },
        ],
      }),
    }
  );

  if (!res.ok) {
    // ---- TEMPORARY DEBUG — remove once verified ----
    const errorBody = await res.text();
    console.log(`GEMINI ERROR (status ${res.status}):`, errorBody);
    // -------------------------------------------------
    if (res.status === 429) throw { rateLimited: true, provider: "gemini" };
    throw new Error(`Gemini request failed with status ${res.status}: ${errorBody}`);
  }

  const data = await res.json();

  // ---- TEMPORARY DEBUG — remove once verified ----
  console.log("RAW GEMINI SUCCESS RESPONSE:", JSON.stringify(data));
  // -------------------------------------------------

  return normalizeGeminiResponse(data);
}

// ---------- Groq adapter (Llama models) ----------
// Groq's API is OpenAI-compatible, so this adapter is nearly identical
// to Cerebras's — smallest adapter cost of the three.
function buildOpenAIMessages(messages) {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content ?? null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

async function callGroq(messages) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: buildOpenAIMessages(messages),
      tools: toolDefs.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: { type: "object", properties: paramsToSchema(t.params) },
        },
      })),
    }),
  });

  if (!res.ok) {
    // ---- TEMPORARY DEBUG — remove once verified ----
    const errorBody = await res.text();
    console.log(`GROQ ERROR (status ${res.status}):`, errorBody);
    // -------------------------------------------------
    if (res.status === 429) throw { rateLimited: true, provider: "groq" };
    throw new Error(`Groq request failed with status ${res.status}: ${errorBody}`);
  }

  const data = await res.json();
  return normalizeOpenAIResponse(data); // Groq mirrors OpenAI's response shape
}

// ---------- Cerebras adapter (Llama models) ----------
// Cerebras's API is also OpenAI-compatible, same shape as Groq — this
// is the free-tier replacement for the old OpenAI adapter.
async function callCerebras(messages) {
  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CEREBRAS_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b",
      messages: buildOpenAIMessages(messages),
      tools: toolDefs.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: { type: "object", properties: paramsToSchema(t.params) },
        },
      })),
    }),
  });

  if (!res.ok) {
    // ---- TEMPORARY DEBUG — remove once verified ----
    const errorBody = await res.text();
    console.log(`CEREBRAS ERROR (status ${res.status}):`, errorBody);
    // -------------------------------------------------
    if (res.status === 429) throw { rateLimited: true, provider: "cerebras" };
    throw new Error(`Cerebras request failed with status ${res.status}: ${errorBody}`);
  }

  const data = await res.json();
  return normalizeOpenAIResponse(data); // Cerebras mirrors OpenAI's response shape
}

// ---------- Shared helpers ----------
function paramsToSchema(params) {
  const props = {};
  for (const [key, type] of Object.entries(params)) {
    props[key] = { type: type.includes("string") ? "string" : "number" };
  }
  return props;
}

function safeParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return { raw: str };
  }
}

function wrapAsObject(value) {
  const isPlainObject =
    value !== null && typeof value === "object" && !Array.isArray(value);
  return isPlainObject ? value : { result: value };
}

// Every provider's response gets normalized to the same shape so the
// rest of your app (tool execution, UI rendering) doesn't care which
// provider answered. toolCalls now always carry an `id` so the result
// can be matched back to the call that requested it.
function normalizeOpenAIResponse(data) {
  const choice = data.choices[0].message;
  return {
    text: choice.content,
    toolCalls: (choice.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
  };
}
function normalizeGeminiResponse(data) {
  const parts = data.candidates[0].content.parts;
  const textPart = parts.find((p) => p.text);
  const funcParts = parts.filter((p) => p.functionCall);
  return {
    text: textPart?.text,
    toolCalls: funcParts.map((p) => ({
      id: p.functionCall.id,
      name: p.functionCall.name,
      arguments: JSON.stringify(p.functionCall.args || {}),
      // Required by Gemini 3.5 to be echoed back verbatim on the
      // follow-up call — see buildGeminiContents.
      thoughtSignature: p.thoughtSignature,
    })),
  };
}

// ---------- Tenant name resolution (fuzzy match) ----------
// Admins search by name, not by the tenantId Firestore actually stores.
// This resolves a possibly-misspelled name to zero, one, or several
// candidate tenantId values without needing to know in advance whether
// there's a dedicated `tenants` collection or whether `tenantId` on
// payment docs already holds the name directly — it checks the former
// first and falls back to deriving candidates from `payments`.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// Falls back through the field names a tenant's display name might
// actually be stored under. `name` was the original assumption but the
// debug logs showed real candidates coming back labeled with raw
// Firestore doc IDs (e.g. "id_mruew5ln90g2ie") — meaning `name` doesn't
// exist on these docs and every fuzzy match was silently comparing the
// admin's query against an ID string instead of an actual name.
function resolveTenantLabel(data) {
  if (data.name) return data.name;
  if (data.fullName) return data.fullName;
  if (data.tenantName) return data.tenantName;
  if (data.displayName) return data.displayName;
  if (data.firstName || data.lastName) {
    return [data.firstName, data.lastName].filter(Boolean).join(" ");
  }
  return null;
}

async function getTenantCandidates(adminUid) {
  const adminRef = db.collection("users").doc(adminUid);

  // users/{adminUid}/tenants is the real, rules-confirmed source of
  // truth for tenant records (see firestore.rules — tenants store under
  // the owner rule, plus dedicated tenant-portal carve-outs). Each doc's
  // ID is the tenantId used everywhere else (payments, maintenanceRequests).
  const tenantsSnap = await adminRef.collection("tenants").limit(1000).get();
  if (!tenantsSnap.empty) {
    return tenantsSnap.docs.map((d) => {
      const data = d.data();
      const label = resolveTenantLabel(data);
      if (!label) {
        // ---- TEMPORARY DEBUG — remove once the field name is confirmed ----
        console.log(
          `WARNING: tenant ${d.id} has no usable name field — matching this ` +
            `candidate by name will never succeed. Doc fields present:`,
          Object.keys(data)
        );
        // ---------------------------------------------------------------------
      }
      // hasName lets resolveTenant() tell "no name on record" apart from
      // "name didn't match" — matching a real query against a raw doc ID
      // isn't a meaningful fuzzy comparison, so these get excluded from
      // scoring rather than silently costing every real tenant a shot at
      // matching (a bad distance-16 "candidate" doesn't crowd out a good one,
      // but it's still noise, and the console warning above is the real fix).
      return { tenantId: d.id, label: label || d.id, hasName: !!label };
    });
  }

  // Defensive fallback only — shouldn't normally be needed given the
  // above, but covers a tenants subcollection that's empty/not yet
  // populated for this admin while payments already exist.
  const paySnap = await adminRef.collection("payments").select("tenantId").get();
  const seen = new Set();
  const candidates = [];
  for (const doc of paySnap.docs) {
    const id = doc.data().tenantId;
    if (id && !seen.has(id)) {
      seen.add(id);
      candidates.push({ tenantId: id, label: id, hasName: false });
    }
  }
  return candidates;
}

async function resolveTenant(query, adminUid) {
  const candidates = await getTenantCandidates(adminUid);

  // ---- TEMPORARY DEBUG — remove once tenant matching is confirmed ----
  console.log(
    `TENANT CANDIDATES (${candidates.length}) for query "${query}":`,
    JSON.stringify(candidates.map((c) => ({ label: c.label, hasName: c.hasName })))
  );
  // ----------------------------------------------------------------------

  if (candidates.length === 0) return { type: "none", matches: [] };

  // Candidates with no real name on record can't be meaningfully compared
  // against a name query — matching "Rachell Bitualla" against an ID
  // string like "id_mruew5ln90g2ie" isn't a fuzzy near-miss, it's noise
  // that should never win. Score only the ones with an actual name.
  const nameable = candidates.filter((c) => c.hasName);
  if (nameable.length === 0) {
    console.log(
      `No tenant candidates for admin have a resolvable name field — ` +
        `check the Firestore schema (see resolveTenantLabel).`
    );
    return { type: "none", matches: [] };
  }

  const normalizedQuery = query.trim().toLowerCase();
  const scored = nameable.map((c) => {
    const normalizedLabel = c.label.trim().toLowerCase();
    // Score the query against the full label AND against each individual
    // word in it (first name, last name, etc). A bare first name like
    // "Rachelle" is naturally far in edit distance from a full two-word
    // label like "rachell bitualla" — the full-label distance alone would
    // never clear either threshold below, no matter how close a typo it is
    // to the first name specifically. tokenDistance catches that case.
    const tokens = normalizedLabel.split(/\s+/).filter(Boolean);
    let tokenDistance = Infinity;
    for (const t of tokens) {
      const d = levenshtein(normalizedQuery, t);
      if (d < tokenDistance) tokenDistance = d;
    }
    return {
      ...c,
      exact: normalizedLabel === normalizedQuery,
      distance: levenshtein(normalizedQuery, normalizedLabel),
      tokenDistance,
    };
  });

  // ---- TEMPORARY DEBUG — remove once tenant matching is confirmed ----
  console.log(
    "SCORED CANDIDATES:",
    JSON.stringify(
      scored.map((s) => ({
        label: s.label,
        distance: s.distance,
        tokenDistance: s.tokenDistance,
        exact: s.exact,
      }))
    )
  );
  // ----------------------------------------------------------------------


  const exactMatches = scored.filter((s) => s.exact);
  if (exactMatches.length === 1) return { type: "exact", matches: exactMatches };
  if (exactMatches.length > 1) return { type: "ambiguous", matches: exactMatches };

  // No exact match — allow a small number of edits, scaled loosely to
  // name length, so a single missing/wrong character still resolves.
  const threshold = Math.max(1, Math.round(normalizedQuery.length * 0.2));
  const close = scored
    .filter((s) => s.distance <= threshold)
    .sort((a, b) => a.distance - b.distance);

  if (close.length === 1) return { type: "fuzzy", matches: close };
  if (close.length > 1) {
    // Multiple candidates within the threshold — only treat as ambiguous
    // if more than one is close to the *best* distance found, so one
    // clearly-closer match still wins over distant runners-up.
    const bestDistance = close[0].distance;
    const tied = close.filter((s) => s.distance === bestDistance);
    if (tied.length === 1) return { type: "fuzzy", matches: tied };
    return { type: "ambiguous", matches: tied.slice(0, 5) };
  }

  // Nothing on the FULL label was close enough to auto-use. Before
  // falling back further, check for a token-level near-miss — the admin
  // typed (something close to) just one name from the label, e.g. a
  // first name alone. This never auto-resolves — matching one word
  // doesn't confirm the whole identity — but it's a strong enough signal
  // to suggest and let the admin confirm, rather than a flat rejection.
  const tokenThreshold = Math.max(1, Math.round(normalizedQuery.length * 0.3));
  const tokenClose = scored
    .filter((s) => s.tokenDistance <= tokenThreshold)
    .sort((a, b) => a.tokenDistance - b.tokenDistance);

  if (tokenClose.length > 0) {
    return { type: "suggestion", matches: [tokenClose[0]] };
  }

  // Last resort: nearest candidate by full-label distance, for typos
  // that don't cleanly land on either the full name or a single token
  // (e.g. a missing middle name, or words in a different order).
  const nearest = scored.slice().sort((a, b) => a.distance - b.distance)[0];
  const suggestThreshold = Math.max(threshold + 2, Math.round(normalizedQuery.length * 0.45));
  if (nearest && nearest.distance <= suggestThreshold) {
    return { type: "suggestion", matches: [nearest] };
  }

  return { type: "none", matches: [] };
}

// ---------- Rent-overdue calculation ----------
// CONFIRMED (Firestore console, 2026-07-27): payments docs have no
// status:"overdue" value — status is a payment-CONFIRMATION state
// (e.g. "paid" once a tenant-portal submission is accepted), never a
// tenant-overdue state. "Overdue" is never stored anywhere; the app
// itself derives it live by walking every calendar month from the
// tenant's moveInDate to today and comparing that month's rent balance
// against the unit's fixed dueDay (see chargeStatus()/
// computeOverdueHistory()/computeOutstandingBalance() in index.html —
// this is a direct Node port of that same logic, so the agent's answer
// matches what the admin sees on screen). Rent-only for now — electricity
// /water aren't included since utilityBills isn't populated yet; add the
// same weighted-split treatment index.html uses once it is.
function monthKeyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function periodsBetween(fromPeriod, toPeriod) {
  const periods = [];
  let [y, m] = fromPeriod.split("-").map(Number);
  const [y2, m2] = toPeriod.split("-").map(Number);
  let guard = 0;
  while ((y < y2 || (y === y2 && m <= m2)) && guard < 240) {
    periods.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
    guard++;
  }
  return periods;
}

// balance>0 and due date already passed => overdue; within 3 days => due-soon;
// further out => upcoming; no balance => paid. Mirrors chargeStatus() exactly.
function chargeStatus(balance, dueDate, today) {
  const daysDiff = Math.floor((today - dueDate) / 86400000);
  let status = "paid";
  if (balance > 0) {
    if (daysDiff > 0) status = "overdue";
    else if (daysDiff >= -3) status = "due-soon";
    else status = "upcoming";
  }
  return { status, daysOverdue: Math.max(0, daysDiff) };
}

// Sums rent paid for one tenant+period from a pre-fetched list of that
// tenant's payment docs. Untagged payments count fully toward rent since
// there's no utility bill this period to split against yet (mirrors
// amountPaidForCharge()'s fallback when totalExpected === rentAmt).
// Bounced checks and deposit-tagged payments never count toward rent.
function rentPaidForPeriod(paymentsForTenant, period) {
  return paymentsForTenant
    .filter((p) => p.coveredPeriod === period && p.tag !== "deposit" && p.clearanceStatus !== "bounced")
    .reduce((sum, p) => {
      const amt = Number(p.amountPaid) || 0;
      if (!amt) return sum;
      if (p.tag) return p.tag === "rent" ? sum + amt : sum;
      return sum + amt;
    }, 0);
}

// Consecutive overdue months counting backward from today, stopping at
// the first caught-up month — exactly computeOverdueHistory()'s behavior
// (a due-soon/upcoming month is skipped, not a break, since it isn't due yet).
function computeMonthsOverdue(tenant, unit, paymentsForTenant, today) {
  const rentAmt = Number(unit.monthlyRent) || 0;
  if (!rentAmt) return 0;
  const dueDay = Math.min(Math.max(Number(unit.dueDay) || 1, 1), 28);
  const moveIn = tenant.moveInDate ? new Date(tenant.moveInDate + "T00:00:00") : today;
  const periods = periodsBetween(monthKeyOf(moveIn), monthKeyOf(today));
  let months = 0;
  for (let i = periods.length - 1; i >= 0; i--) {
    const [y, m] = periods[i].split("-").map(Number);
    const dueDate = new Date(y, m - 1, dueDay);
    const paid = rentPaidForPeriod(paymentsForTenant, periods[i]);
    const balance = Math.max(0, rentAmt - paid);
    const { status } = chargeStatus(balance, dueDate, today);
    if (status === "paid") break;
    if (status !== "overdue") continue;
    months++;
  }
  return months;
}

// Total rent balance outstanding across EVERY overdue period from
// moveInDate to today (not just the consecutive streak) — matches
// computeOutstandingBalance()'s rent total.
function computeOutstandingRent(tenant, unit, paymentsForTenant, today) {
  const rentAmt = Number(unit.monthlyRent) || 0;
  if (!rentAmt) return 0;
  const dueDay = Math.min(Math.max(Number(unit.dueDay) || 1, 1), 28);
  const moveIn = tenant.moveInDate ? new Date(tenant.moveInDate + "T00:00:00") : today;
  const periods = periodsBetween(monthKeyOf(moveIn), monthKeyOf(today));
  let total = 0;
  for (const period of periods) {
    const [y, m] = period.split("-").map(Number);
    const dueDate = new Date(y, m - 1, dueDay);
    const paid = rentPaidForPeriod(paymentsForTenant, period);
    const balance = Math.max(0, rentAmt - paid);
    if (chargeStatus(balance, dueDate, today).status === "overdue") total += balance;
  }
  return Math.round(total);
}

// ---------- Tool execution (Firestore) ----------
// Same logic already wired into agent-openrouter.js — the tool results
// don't depend on which provider is asking for them.
//
// SCOPING: every query here is scoped under users/{adminUid}/{store},
// matching the real schema in firestore.rules. The Admin SDK bypasses
// security rules entirely, so this scoping has to be enforced here in
// code — nothing stops an unscoped query from reading every admin's
// data at once. adminUid comes from the caller's verified auth (see
// index.js), never from the model or the request body.
//
// NOTE: getTenantPaymentStatus sorts in JavaScript instead of using
// Firestore's .orderBy() — that avoids needing a composite Firestore
// index (where + orderBy together require one to be manually created).
async function executeTool(name, args, adminUid) {
  const adminRef = db.collection("users").doc(adminUid);

  if (name === "getTenantPaymentStatus") {
    const resolution = await resolveTenant(args.tenantName, adminUid);

    if (resolution.type === "none") {
      return {
        error: `No tenant found matching "${args.tenantName}". Ask the admin to double-check the spelling or provide a unit number.`,
      };
    }
    if (resolution.type === "suggestion") {
      // Not confident enough to use automatically — surface the nearest
      // candidate as a suggestion only. The model must ask before using it,
      // never treat this the way it treats wasExactMatch: false.
      return {
        error: `No confident match for "${args.tenantName}".`,
        suggestedTenant: resolution.matches[0].label,
      };
    }
    if (resolution.type === "ambiguous") {
      return {
        error: `Multiple tenants closely match "${args.tenantName}".`,
        candidates: resolution.matches.map((m) => m.label),
      };
    }

    const resolved = resolution.matches[0];
    const tenantDoc = await adminRef.collection('tenants').doc(resolved.tenantId).get();
    const tenant = tenantDoc.exists ? tenantDoc.data() : null;
    const unitDoc = tenant && tenant.unitId ? await adminRef.collection('units').doc(tenant.unitId).get() : null;
    const unit = unitDoc && unitDoc.exists ? unitDoc.data() : null;

    if (!tenant || !unit) {
      return {
        matchedTenant: resolved.label,
        wasExactMatch: resolution.type === "exact",
        error: "This tenant has no unit assigned, so rent status can't be calculated.",
      };
    }

    const snapshot = await adminRef.collection('payments')
      .where('tenantId', '==', resolved.tenantId)
      .get();

    // ---- TEMPORARY DEBUG — remove once confirmed ----
    console.log(
      `PAYMENTS QUERY for matched tenant "${resolved.label}" (tenantId: ${resolved.tenantId}): ` +
        `${snapshot.empty ? "EMPTY" : `${snapshot.size} record(s)`}`
    );
    // ---------------------------------------------------

    // A resolved match with zero payment history is NOT the same as
    // "couldn't find the tenant" — without matchedTenant here, the model
    // has no way to know the name actually resolved, and (as seen in
    // testing) will retry with a shortened/different name assuming the
    // first lookup failed, then conflate both dead ends into one reply.
    const paymentsForTenant = snapshot.docs.map(d => d.data());
    if (paymentsForTenant.length === 0 && !tenant.moveInDate) {
      return {
        matchedTenant: resolved.label,
        wasExactMatch: resolution.type === "exact",
        error: "No payment records found for this tenant.",
      };
    }

    const today = new Date();
    const monthsOverdue = computeMonthsOverdue(tenant, unit, paymentsForTenant, today);
    const balanceOwed = computeOutstandingRent(tenant, unit, paymentsForTenant, today);

    paymentsForTenant.sort((a, b) => (b.datePaid || "").localeCompare(a.datePaid || ""));
    const latest = paymentsForTenant[0] || null;

    return {
      matchedTenant: resolved.label,
      wasExactMatch: resolution.type === "exact",
      status: monthsOverdue > 0 ? "overdue" : "current",
      monthsOverdue,
      balanceOwed,
      lastPayment: latest
        ? { amount: latest.amountPaid, date: latest.datePaid, coveredPeriod: latest.coveredPeriod }
        : null,
    };
  }

  if (name === "getMaintenanceRequests") {
    const snapshot = await adminRef.collection('maintenanceRequests')
      .where('status', 'in', ['open', 'in_progress'])
      .get();

    let results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    if (args.olderThanDays) {
      const cutoff = Date.now() - args.olderThanDays * 24 * 60 * 60 * 1000;
      results = results.filter(r => r.createdAt?.toMillis?.() < cutoff);
    }

    return results.map(r => ({
      title: r.title,
      category: r.category,
      urgency: r.urgency,
      status: r.status,
      createdAt: r.createdAt,
    }));
  }

  if (name === "getTenantByName") {
    // Identity lookup only — no payment query. Reuses resolveTenant() so
    // it stays consistent with getTenantPaymentStatus's matching behavior
    // (exact/fuzzy/suggestion/ambiguous/none), without pulling payment data
    // the admin didn't ask for.
    const resolution = await resolveTenant(args.tenantName, adminUid);

    if (resolution.type === "none") {
      return {
        error: `No tenant found matching "${args.tenantName}". Ask the admin to double-check the spelling or provide a unit number.`,
      };
    }
    if (resolution.type === "suggestion") {
      return {
        error: `No confident match for "${args.tenantName}".`,
        suggestedTenant: resolution.matches[0].label,
      };
    }
    if (resolution.type === "ambiguous") {
      return {
        error: `Multiple tenants closely match "${args.tenantName}".`,
        candidates: resolution.matches.map((m) => m.label),
      };
    }

    const resolved = resolution.matches[0];
    return {
      matchedTenant: resolved.label,
      wasExactMatch: resolution.type === "exact",
    };
  }

  if (name === "getAllTenants") {
    // Reuses the same candidate-gathering logic getTenantPaymentStatus
    // scores against, so this stays in sync with resolveTenantLabel()'s
    // field-name fallback and the "no usable name field" warning — no
    // separate query/label logic to keep consistent here.
    const candidates = await getTenantCandidates(adminUid);
    // Exclude candidates with no resolvable name field (hasName: false) —
    // those are labeled with a raw Firestore doc ID as a fallback for
    // fuzzy-matching purposes, which would look like broken data if shown
    // in a tenant list rather than silently scored against.
    const named = candidates.filter((c) => c.hasName);

    return {
      tenants: named.map((c) => c.label),
      count: named.length,
      ...(named.length < candidates.length
        ? { note: `${candidates.length - named.length} additional tenant record(s) on file have no name set and are omitted from this list.` }
        : {}),
    };
  }

  if (name === "getOverdueTenants") {
    // "Overdue" isn't a stored field on any payment doc — see the
    // comment above computeMonthsOverdue(). Derive it the same way the
    // app itself does: for every active tenant with an assigned unit,
    // walk rent month-by-month from moveInDate to today against the
    // unit's dueDay.
    const [tenantsSnap, unitsSnap, paymentsSnap] = await Promise.all([
      adminRef.collection('tenants').limit(1000).get(),
      adminRef.collection('units').limit(1000).get(),
      adminRef.collection('payments').limit(5000).get(),
    ]);

    const unitById = new Map(unitsSnap.docs.map((d) => [d.id, d.data()]));
    const paymentsByTenant = new Map();
    for (const doc of paymentsSnap.docs) {
      const data = doc.data();
      if (!data.tenantId) continue;
      const list = paymentsByTenant.get(data.tenantId) || [];
      list.push(data);
      paymentsByTenant.set(data.tenantId, list);
    }

    const today = new Date();
    const overdue = [];
    for (const doc of tenantsSnap.docs) {
      const tenant = doc.data();
      if (tenant.active === false) continue; // moved-out tenants aren't currently overdue
      const unit = tenant.unitId ? unitById.get(tenant.unitId) : null;
      if (!unit) continue; // no unit assigned — nothing to be overdue on
      const label = resolveTenantLabel(tenant);
      if (!label) continue;
      const paymentsForTenant = paymentsByTenant.get(doc.id) || [];
      const monthsOverdue = computeMonthsOverdue(tenant, unit, paymentsForTenant, today);
      if (monthsOverdue > 0) {
        overdue.push({
          tenantName: label,
          monthsOverdue,
          balance: computeOutstandingRent(tenant, unit, paymentsForTenant, today),
        });
      }
    }

    overdue.sort((a, b) => b.monthsOverdue - a.monthsOverdue);
    return { overdueTenants: overdue, count: overdue.length };
  }

  if (name === "getPayments") {
    let query = adminRef.collection('payments');
    if (args.status) query = query.where('status', '==', args.status);
    const snapshot = await query.get();

    const docs = snapshot.docs.map(d => d.data());
    // Sort by datePaid descending — the real field name (confirmed in the
    // Firestore console); "date" never existed on these docs.
    docs.sort((a, b) => (b.datePaid || "").localeCompare(a.datePaid || ""));

    const candidates = await getTenantCandidates(adminUid);
    const labelById = new Map(candidates.map((c) => [c.tenantId, c.label]));

    return docs.map((d) => ({
      tenantName: labelById.get(d.tenantId) || d.tenantId,
      status: d.status,          // payment-confirmation state (e.g. "paid"), not overdue status
      amount: d.amountPaid,
      coveredPeriod: d.coveredPeriod,
      date: d.datePaid,
      tag: d.tag,
    }));
  }

  if (name === "getTenantByUnit") {
    const rawUnitLabel = (args.unitLabel || "").toString().trim();
    const rawLocationName = (args.locationName || "").toString().trim();

    if (!rawUnitLabel) {
      return { error: "No unit number/label provided." };
    }

    // Loose match helper: strips spaces/punctuation and lowercases, so
    // "Unit 301", "301", and " 301 " all compare equal, and location
    // names tolerate partial matches ("Caloocan" vs "Caloocan City").
    const normalize = (s) => (s || "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");

    // Resolve location first if given — narrows which unit(s) count as a
    // match, since the same unit label can exist at more than one property.
    let locationIds = null;
    let matchedLocationName = null;
    if (rawLocationName) {
      const locSnap = await adminRef.collection('locations').limit(1000).get();
      const normalizedQuery = normalize(rawLocationName);
      const locMatches = locSnap.docs.filter((d) => {
        const locName = normalize(d.data().name);
        return locName === normalizedQuery || locName.includes(normalizedQuery) || normalizedQuery.includes(locName);
      });
      if (locMatches.length === 0) {
        return { error: `No location found matching "${rawLocationName}".` };
      }
      if (locMatches.length > 1) {
        return {
          error: `Multiple locations match "${rawLocationName}".`,
          candidates: locMatches.map((d) => d.data().name),
        };
      }
      locationIds = [locMatches[0].id];
      matchedLocationName = locMatches[0].data().name;
    }

    const unitsSnap = await adminRef.collection('units').limit(1000).get();
    const normalizedUnitQuery = normalize(rawUnitLabel);
    let unitMatches = unitsSnap.docs.filter((d) => normalize(d.data().unitLabel) === normalizedUnitQuery);
    if (locationIds) {
      unitMatches = unitMatches.filter((d) => locationIds.includes(d.data().locationId));
    }

    if (unitMatches.length === 0) {
      return {
        error: `No unit found matching "${rawUnitLabel}"${matchedLocationName ? ` in ${matchedLocationName}` : ""}.`,
      };
    }

    if (unitMatches.length > 1) {
      // Same unit label at more than one property — don't guess which
      // one the admin meant, ask them (via the calling model) instead.
      const locSnap = await adminRef.collection('locations').limit(1000).get();
      const locNameById = new Map(locSnap.docs.map((d) => [d.id, d.data().name]));
      return {
        error: `Multiple units are labeled "${rawUnitLabel}" across different properties.`,
        candidates: unitMatches.map((d) => locNameById.get(d.data().locationId) || d.data().locationId),
      };
    }

    const unitDoc = unitMatches[0];
    const unit = unitDoc.data();

    let locationName = matchedLocationName;
    if (!locationName && unit.locationId) {
      const locDoc = await adminRef.collection('locations').doc(unit.locationId).get();
      locationName = locDoc.exists ? locDoc.data().name : null;
    }

    const tenantsSnap = await adminRef.collection('tenants')
      .where('unitId', '==', unitDoc.id)
      .limit(5)
      .get();
    const tenantNames = tenantsSnap.docs
      .map((d) => resolveTenantLabel(d.data()))
      .filter(Boolean);

    return {
      unitLabel: unit.unitLabel ?? rawUnitLabel,
      location: locationName ?? null,
      status: unit.status ?? null,
      monthlyRent: unit.monthlyRent ?? null,
      tenants: tenantNames,
    };
  }

  if (name === "getVacantUnits") {
    const unitsSnap = await adminRef.collection('units').limit(1000).get();
    const locSnap = await adminRef.collection('locations').limit(1000).get();
    const locNameById = new Map(locSnap.docs.map((d) => [d.id, d.data().name]));

    const vacant = unitsSnap.docs.filter((d) => d.data().status === 'vacant');
    return vacant.map((d) => {
      const u = d.data();
      return {
        unitLabel: u.unitLabel ?? d.id,
        location: locNameById.get(u.locationId) || null,
        monthlyRent: u.monthlyRent ?? null,
      };
    });
  }

  if (name === "getOccupiedUnits") {
    const unitsSnap = await adminRef.collection('units').limit(1000).get();
    const locSnap = await adminRef.collection('locations').limit(1000).get();
    const locNameById = new Map(locSnap.docs.map((d) => [d.id, d.data().name]));

    // Group tenants by unitId once, instead of a per-unit query, since we
    // need this for every occupied unit in the result.
    const tenantsSnap = await adminRef.collection('tenants').limit(1000).get();
    const tenantsByUnitId = new Map();
    for (const d of tenantsSnap.docs) {
      const data = d.data();
      if (!data.unitId) continue;
      const label = resolveTenantLabel(data);
      if (!label) continue;
      const list = tenantsByUnitId.get(data.unitId) || [];
      list.push(label);
      tenantsByUnitId.set(data.unitId, list);
    }

    const occupied = unitsSnap.docs.filter((d) => d.data().status === 'occupied');
    return occupied.map((d) => {
      const u = d.data();
      return {
        unitLabel: u.unitLabel ?? d.id,
        location: locNameById.get(u.locationId) || null,
        monthlyRent: u.monthlyRent ?? null,
        tenants: tenantsByUnitId.get(d.id) || [],
      };
    });
  }

  if (name === "getExpectedIncome") {
    // Projection from unit records (monthlyRent on occupied units), not
    // actual collections — see getMonthlyIncome for what's been paid.
    const unitsSnap = await adminRef.collection('units').limit(1000).get();
    const occupied = unitsSnap.docs.filter((d) => d.data().status === 'occupied');
    const total = occupied.reduce((sum, d) => sum + (d.data().monthlyRent || 0), 0);
    return { expectedMonthlyIncome: total, occupiedUnitCount: occupied.length };
  }

  if (name === "getMonthlyIncome") {
    // Only counts payments actually marked "paid" within the current
    // calendar month, using the real field names confirmed in the
    // Firestore console (amountPaid/datePaid — not amount/date, which
    // never existed on these docs and silently made this always return 0).
    const snapshot = await adminRef.collection('payments')
      .where('status', '==', 'paid')
      .get();

    const now = new Date();
    const thisMonth = snapshot.docs
      .map(d => d.data())
      .filter((d) => {
        if (!d.datePaid) return false;
        const t = new Date(d.datePaid + 'T00:00:00');
        return t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth();
      });

    const total = thisMonth.reduce((sum, d) => sum + (Number(d.amountPaid) || 0), 0);
    return { collectedThisMonth: Math.round(total), paymentCount: thisMonth.length };
  }
}

// ---------- The fallback chain itself ----------
const PROVIDER_CHAIN = [
  { name: "gemini", call: callGemini },
  { name: "groq", call: callGroq },
  { name: "cerebras", call: callCerebras },
];

// Cap on how many tool-call round-trips a single askAgent() call will do
// before giving up. Needed because some admin requests chain naturally
// (e.g. "list open requests, then check payment status for unit 301") —
// see Issue #9.
const MAX_TOOL_ROUNDS = 5;

async function askAgent(userMessage, history = [], adminUid) {
  if (!adminUid) {
    throw new Error("askAgent requires adminUid — every Firestore query must be scoped to a specific admin's data.");
  }

  const baseMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userMessage },
  ];

  for (const provider of PROVIDER_CHAIN) {
    try {
      let messages = baseMessages;
      let result = await provider.call(messages);
      let rounds = 0;

      // Loop as long as the model keeps asking for tools, instead of
      // handling only a single call/result round-trip. The old version
      // ran the tool once, asked the provider exactly one follow-up
      // question, and returned whatever came back — even if THAT
      // response was itself another functionCall. In that case `.text`
      // was undefined and index.js sent the client `{ reply: undefined }`
      // with no error anywhere (see Issue #9).
      while (result.toolCalls && result.toolCalls.length > 0 && rounds < MAX_TOOL_ROUNDS) {
        rounds++;

        const toolResultMessages = await Promise.all(
          result.toolCalls.map(async (call) => {
            const args = JSON.parse(call.arguments || "{}");
            const toolResult = await executeTool(call.name, args, adminUid);
            return {
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: JSON.stringify(toolResult),
            };
          })
        );

        // Re-insert the assistant's own tool-call turn before the
        // results — Gemini in particular rejects a function response
        // that isn't preceded by the matching function-call turn.
        const assistantToolCallMessage = {
          role: "assistant",
          content: result.text ?? null,
          toolCalls: result.toolCalls,
        };

        messages = [...messages, assistantToolCallMessage, ...toolResultMessages];
        result = await provider.call(messages);

        // ---- TEMPORARY DEBUG — remove once verified ----
        console.log(`TOOL ROUND ${rounds} RESULT (provider: ${provider.name}):`, JSON.stringify(result));
        // -------------------------------------------------
      }

      if (result.toolCalls && result.toolCalls.length > 0) {
        // Hit MAX_TOOL_ROUNDS without a final text answer. Return
        // something the client can actually show, instead of a bare
        // toolCalls array with no .text.
        console.log(`Gave up after ${MAX_TOOL_ROUNDS} tool rounds, provider: ${provider.name}`);
        return {
          text: "Sorry, I couldn't finish that one — could you try asking for one thing at a time?",
          toolCalls: [],
        };
      }

      // ---- TEMPORARY DEBUG — remove once verified ----
      console.log(`FINAL RESULT (provider: ${provider.name}, rounds: ${rounds}):`, JSON.stringify(result));
      // -------------------------------------------------

      return result;
    } catch (err) {
      if (err.rateLimited) {
        console.log(`${err.provider} rate-limited, trying next provider`);
        continue;
      }
      throw err;
    }
  }
  throw new Error("All providers exhausted or failed");
}

module.exports = { askAgent };

/**
 * WHAT YOU GET:
 * - No middleman, no markup, direct billing relationship with each provider
 * - Full control over retry/timeout/error behavior per provider
 * - All three tiers used here are genuinely free, no credit card required
 *
 * WHAT YOU GIVE UP:
 * - You wrote and maintain 3 adapters (request shape + response shape each)
 * - Adding a 4th provider later = another adapter, not a one-line list edit
 * - You own the "is this a rate-limit error" detection per provider
 *   (status codes and error bodies differ slightly across the three)
 */