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

const SYSTEM_PROMPT = `You are the UpaPro admin assistant, used by property managers running boarding-house/rental operations. You help them check tenant payment status and open maintenance requests.

Data model:
- Payment status values: "paid" (settled), "pending" (awaiting confirmation), "overdue" (past due date, unpaid).
- Maintenance status values: "open" (not yet started), "in_progress" (being worked on). Urgency is a plain descriptive field (e.g. low/medium/high), not a fixed enum you should re-derive.

Tenant lookups (getTenantPaymentStatus) are matched by name, not by an exact system ID, and small typos are tolerated automatically. Pass through whatever name the admin gives, even if the spelling looks slightly off — don't correct it yourself first. React to what the tool returns:
- If the result includes "wasExactMatch: false", a close-but-imperfect match was used — briefly confirm which tenant you're showing before answering (e.g. "Showing results for Rachel Bituala — let me know if that's not who you meant.").
- If the result is an error naming multiple close matches ("candidates"), list those names back to the admin and ask which one they meant. Don't pick one yourself.
- If the result is a "no tenant found" error, say so plainly and ask the admin to double-check the spelling or give a unit number instead. Don't imply the tenant has no payment history — the name just didn't match anyone.

Behavior:
- Never invent tenant names, amounts, dates, or statuses. If a tool result is missing a field, say it's missing rather than filling in a plausible-sounding value.
- Be concise. Admins are checking this between other tasks, not having a conversation.
- You have no visibility into anything outside what the tools return — don't reference dates, tenants, or requests you haven't looked up in this conversation.`;

// Tool schema defined once in a neutral shape; each adapter converts it
// into the format that provider expects.
const toolDefs = [
  {
    name: "getTenantPaymentStatus",
    description:
      "Look up a tenant's current rent payment status and balance by name. Small typos are " +
      "tolerated — pass whatever name the admin gave, even if the spelling might be slightly off.",
    params: { tenantName: "string" },
  },
  {
    name: "listOpenMaintenanceRequests",
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
              // repeating, cannot start list") — listOpenMaintenanceRequests
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

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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

async function getTenantCandidates(adminUid) {
  const adminRef = db.collection("users").doc(adminUid);

  // users/{adminUid}/tenants is the real, rules-confirmed source of
  // truth for tenant records (see firestore.rules — tenants store under
  // the owner rule, plus dedicated tenant-portal carve-outs). Each doc's
  // ID is the tenantId used everywhere else (payments, maintenanceRequests).
  const tenantsSnap = await adminRef.collection("tenants").limit(1000).get();
  if (!tenantsSnap.empty) {
    return tenantsSnap.docs.map((d) => ({
      tenantId: d.id,
      label: d.data().name || d.id,
    }));
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
      candidates.push({ tenantId: id, label: id });
    }
  }
  return candidates;
}

async function resolveTenant(query, adminUid) {
  const candidates = await getTenantCandidates(adminUid);

  // ---- TEMPORARY DEBUG — remove once tenant matching is confirmed ----
  console.log(
    `TENANT CANDIDATES (${candidates.length}) for query "${query}":`,
    JSON.stringify(candidates.map((c) => c.label))
  );
  // ----------------------------------------------------------------------

  if (candidates.length === 0) return { type: "none", matches: [] };

  const normalizedQuery = query.trim().toLowerCase();
  const scored = candidates.map((c) => {
    const normalizedLabel = c.label.trim().toLowerCase();
    return {
      ...c,
      exact: normalizedLabel === normalizedQuery,
      distance: levenshtein(normalizedQuery, normalizedLabel),
    };
  });

  // ---- TEMPORARY DEBUG — remove once tenant matching is confirmed ----
  console.log(
    "SCORED CANDIDATES:",
    JSON.stringify(scored.map((s) => ({ label: s.label, distance: s.distance, exact: s.exact })))
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

  if (close.length === 0) return { type: "none", matches: [] };
  if (close.length === 1) return { type: "fuzzy", matches: close };
  // Multiple candidates within the threshold — only treat as ambiguous
  // if more than one is close to the *best* distance found, so one
  // clearly-closer match still wins over distant runners-up.
  const bestDistance = close[0].distance;
  const tied = close.filter((s) => s.distance === bestDistance);
  if (tied.length === 1) return { type: "fuzzy", matches: tied };
  return { type: "ambiguous", matches: tied.slice(0, 5) };
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
    if (resolution.type === "ambiguous") {
      return {
        error: `Multiple tenants closely match "${args.tenantName}".`,
        candidates: resolution.matches.map((m) => m.label),
      };
    }

    const resolved = resolution.matches[0];
    const snapshot = await adminRef.collection('payments')
      .where('tenantId', '==', resolved.tenantId)
      .get();

    if (snapshot.empty) return { error: "No payment records found for this tenant" };

    const docs = snapshot.docs.map(d => d.data());
    // Sort by date descending in JS — avoids the composite index requirement
    docs.sort((a, b) => {
      const aTime = a.date?.toMillis ? a.date.toMillis() : new Date(a.date).getTime();
      const bTime = b.date?.toMillis ? b.date.toMillis() : new Date(b.date).getTime();
      return bTime - aTime;
    });
    const latest = docs[0];

    return {
      matchedTenant: resolved.label,
      wasExactMatch: resolution.type === "exact",
      status: latest.status,        // e.g. "paid", "pending", "overdue"
      amount: latest.amount,
      date: latest.date,
      balance: latest.balance ?? null,
    };
  }

  if (name === "listOpenMaintenanceRequests") {
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
}

// ---------- The fallback chain itself ----------
const PROVIDER_CHAIN = [
  { name: "gemini", call: callGemini },
  { name: "groq", call: callGroq },
  { name: "cerebras", call: callCerebras },
];

async function askAgent(userMessage, history = [], adminUid) {
  if (!adminUid) {
    throw new Error("askAgent requires adminUid — every Firestore query must be scoped to a specific admin's data.");
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userMessage },
  ];

  for (const provider of PROVIDER_CHAIN) {
    try {
      const result = await provider.call(messages);

      // If the model wants to call a tool, run it and get a final answer
      if (result.toolCalls && result.toolCalls.length > 0) {
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

        // Ask the same provider again with the tool results included
        const followUp = await provider.call([
          ...messages,
          assistantToolCallMessage,
          ...toolResultMessages,
        ]);

        // ---- TEMPORARY DEBUG — remove once verified ----
        console.log(`FINAL RESULT (after tool call, provider: ${provider.name}):`, JSON.stringify(followUp));
        // -------------------------------------------------

        return followUp;
      }

      // ---- TEMPORARY DEBUG — remove once verified ----
      console.log(`FINAL RESULT (no tool call, provider: ${provider.name}):`, JSON.stringify(result));
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