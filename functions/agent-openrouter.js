/**
 * UpaPro AI Agent — OpenRouter approach
 * ---------------------------------------
 * One API, one request/response shape, one tool-calling format.
 * OpenRouter routes to whichever underlying model you list, in order,
 * and falls back automatically if one is rate-limited or down.
 *
 * npm install node-fetch (or use built-in fetch on Node 18+)
 */

const admin = require("firebase-admin");
const db = admin.firestore();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY; // set via `firebase functions:secrets:set`

// Tools are defined ONCE, in OpenAI-compatible function-calling format.
// OpenRouter normalizes this across every model that supports tool use
// (GPT-4o, Gemini, Llama 3.x via Groq/Together, etc.)
const tools = [
  {
    type: "function",
    function: {
      name: "getTenantPaymentStatus",
      description: "Look up a tenant's current rent payment status and balance",
      parameters: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Tenant document ID" },
        },
        required: ["tenantId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listOpenMaintenanceRequests",
      description: "List maintenance requests that are still open or in_progress",
      parameters: {
        type: "object",
        properties: {
          olderThanDays: {
            type: "number",
            description: "Only return requests open longer than this many days",
          },
        },
      },
    },
  },
];

// Model fallback order — cheapest/free-tier-friendly first, better model last.
// OpenRouter tries each in sequence if one errors or is rate-limited.
const MODEL_FALLBACK_LIST = [
  "google/gemini-2.0-flash-exp:free",   // Gemini free tier via OpenRouter
  "meta-llama/llama-3.3-70b-instruct:free", // Llama via free-tier route
  "openai/gpt-4o-mini",                 // paid fallback, cheap, reliable
];

async function callOpenRouterAgent(userMessage, conversationHistory = []) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://your-upapro-domain.com", // required by OpenRouter
      "X-Title": "UpaPro Admin Agent",
    },
    body: JSON.stringify({
      models: MODEL_FALLBACK_LIST, // <-- this is the whole fallback chain
      messages: [
        { role: "system", content: "You are the UpaPro admin assistant. Be concise." },
        ...conversationHistory,
        { role: "user", content: userMessage },
      ],
      tools,
      tool_choice: "auto",
    }),
  });

  const data = await response.json();
  const choice = data.choices[0];

  // If the model wants to call a tool, handle it here
  if (choice.message.tool_calls) {
    const results = await Promise.all(
      choice.message.tool_calls.map(async (call) => {
        const args = JSON.parse(call.function.arguments);
        const result = await executeTool(call.function.name, args); // your Firestore logic
        return {
          tool_call_id: call.id,
          role: "tool",
          content: JSON.stringify(result),
        };
      })
    );

    // Send tool results back for a final natural-language answer
    return callOpenRouterAgent(userMessage, [
      ...conversationHistory,
      choice.message,
      ...results,
    ]);
  }

  return choice.message.content;
}

async function executeTool(name, args) {
  if (name === "getTenantPaymentStatus") {
    const snapshot = await db.collection('payments')
      .where('tenantId', '==', args.tenantId)
      .orderBy('date', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) return { error: "No payment records found for this tenant" };

    const latest = snapshot.docs[0].data();
    return {
      status: latest.status,        // e.g. "paid", "pending", "overdue"
      amount: latest.amount,
      date: latest.date,
      balance: latest.balance ?? null,
    };
  }

  if (name === "listOpenMaintenanceRequests") {
    const snapshot = await db.collection('maintenanceRequests')
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

module.exports = { callOpenRouterAgent };

/**
 * WHAT YOU GET:
 * - One tool schema, works across every model in the fallback list
 * - Fallback is a single array — add/remove/reorder models with no code change
 * - OpenRouter handles retry/fallback logic internally
 *
 * WHAT YOU GIVE UP:
 * - A small per-token markup vs. calling providers directly (usually fractions of a cent)
 * - You're dependent on OpenRouter's uptime as an extra layer
 * - Free-tier models on OpenRouter still carry OpenRouter's own rate limits on top
 */