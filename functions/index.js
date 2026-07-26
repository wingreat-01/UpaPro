const {setGlobalOptions} = require("firebase-functions");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const {askAgent} = require("./agent-manual-fallback");

// For cost control, you can set the maximum number of containers that can be
// running at the same time.
setGlobalOptions({ maxInstances: 10 });

exports.askAgent = onCall(
  { secrets: ["GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY"] },
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
    const result = await askAgent(message, [], adminUid);
    return { reply: result.text };
  }
);