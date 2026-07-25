const {setGlobalOptions} = require("firebase-functions");
const {onCall} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

const {askAgent} = require("./agent-manual-fallback");

// For cost control, you can set the maximum number of containers that can be
// running at the same time.
setGlobalOptions({ maxInstances: 10 });

exports.askAgent = onCall(
  { secrets: ["GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY"] },
  async (request) => {
    const { message } = request.data;
    const result = await askAgent(message);
    return { reply: result.text };
  }
);