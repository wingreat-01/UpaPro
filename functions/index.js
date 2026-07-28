const {setGlobalOptions} = require("firebase-functions");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const {askAgent, testAgentProvider} = require("./agent-manual-fallback");
const {rentDueReminders, testRentDueReminders} = require("./rentReminders");

// For cost control, you can set the maximum number of containers that can be
// running at the same time.
setGlobalOptions({ maxInstances: 10 });

// Cap on stored messages per admin's thread doc — keeps the doc size and
// future context payloads bounded as a thread ages over weeks/months.
const MAX_STORED_MESSAGES = 60;

exports.askAgent = onCall(
  { secrets: ["GEMINI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY"] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be signed in.");
    }
    const adminUid = request.auth.uid;

    // Mirrors the admins/{adminUid} check in firestore.rules. The Admin
    // SDK used by askAgent()/executeTool() bypasses those rules entirely,
    // so this function has to verify independently that the caller is a
    // genuinely linked admin — not just any authenticated Firebase user
    // (a tenant portal account, for instance, has its own uid but no
    // admins/{uid} doc, and must not be able to read another admin's data).
    const adminDoc = await db.collection("admins").doc(adminUid).get();
    if (!adminDoc.exists) {
      throw new HttpsError("permission-denied", "Not a recognized admin account.");
    }

    const { message } = request.data;

    // The client sends its own recent scrollback as context (see
    // loadAiChatHistory()/sendAiChatMessage() in index.html). It's the
    // same admin's own data either way — already gated by the auth check
    // above — so there's no cross-tenant trust concern in accepting it;
    // worst case a malformed entry just gets filtered out below.
    const history = Array.isArray(request.data.history)
      ? request.data.history
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .map((m) => ({ role: m.role, content: m.content }))
      : [];

    const result = await askAgent(message, history, adminUid);
    const reply = result.text || "Sorry, I didn't get a response.";

    // Persist the exchange server-side, so what's stored always matches
    // what was actually sent to the model — not just whatever the client
    // happened to have in memory. A transaction avoids clobbering another
    // near-simultaneous write to the same thread doc.
    try {
      const threadRef = db.collection("users").doc(adminUid).collection("aiAssistant").doc("thread");
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(threadRef);
        const existing = snap.exists && Array.isArray(snap.data().messages) ? snap.data().messages : [];
        const updated = [
          ...existing,
          { role: "user", content: message, at: Date.now() },
          { role: "assistant", content: reply, at: Date.now() },
        ].slice(-MAX_STORED_MESSAGES);
        tx.set(threadRef, { messages: updated, updatedAt: Date.now() });
      });
    } catch (err) {
      // Don't fail the whole call just because persistence failed — the
      // admin still got their answer; they just won't have it remembered
      // next time they open the sheet.
      logger.error("Failed to persist AI chat history:", err);
    }

    return { reply };
  }
);

// Lets you confirm a specific AI provider (gemini/groq/mistral) actually
// works — auth, model name, response shape — without reordering
// PROVIDER_CHAIN and redeploying twice. Same admin-gated pattern as
// testRentDueReminders. Call from the browser console while signed in:
//   firebase.functions().httpsCallable('testAgentProvider')({ provider: 'groq' })
//     .then(r => console.log('result:', r.data))
//     .catch(e => console.error('failed:', e.message));
//
// Pass { provider: '...', mode: 'tool' } to also exercise a real,
// read-only tool call (getOverdueTenants) through that provider — this
// is the check that would have caught Groq's malformed getTenantByUnit
// call before it ever reached a real admin.
exports.testAgentProvider = onCall(
  { secrets: ["GEMINI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY"] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be signed in.");
    }
    const adminUid = request.auth.uid;
    const adminDoc = await db.collection("admins").doc(adminUid).get();
    if (!adminDoc.exists) {
      throw new HttpsError("permission-denied", "Not a recognized admin account.");
    }

    const provider = request.data && request.data.provider;
    if (!provider) {
      throw new HttpsError("invalid-argument", 'Pass { provider: "gemini" | "groq" | "mistral" }.');
    }
    const mode = (request.data && request.data.mode) || "greeting";
    const testPrompt = request.data && request.data.testPrompt;

    try {
      return await testAgentProvider(provider, adminUid, mode, testPrompt);
    } catch (err) {
      throw new HttpsError("internal", err.message);
    }
  }
);

exports.rentDueReminders = rentDueReminders;
exports.testRentDueReminders = testRentDueReminders;