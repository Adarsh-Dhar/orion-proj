import "dotenv/config";
import * as readline from "readline";

// ─── Env validation ───────────────────────────────────────────────────────────

function validateEnv(required: string[]): void {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`ERROR: Missing required environment variable(s): ${missing.join(", ")}`);
    console.error("Check your .env file and ensure all required keys are set.");
    process.exit(1);
  }
}

validateEnv(["GEMINI_API_KEY"]);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY as string;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash-lite";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ContentPart {
  text: string;
}

interface ConversationTurn {
  role: "user" | "model";
  parts: ContentPart[];
}

interface GeminiRequest {
  contents: ConversationTurn[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: ContentPart[];
    };
  }>;
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

// ─── Gemini REST helper ───────────────────────────────────────────────────────

const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

async function callGemini(history: ConversationTurn[]): Promise<string> {
  const body: GeminiRequest = { contents: history };

  const response = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as GeminiResponse;

  // Surface API-level errors clearly
  if (data.error) {
    throw new Error(`Gemini API error ${data.error.code}: ${data.error.message}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  return text.trim();
}

// ─── Conversation history ─────────────────────────────────────────────────────

/**
 * Prime the assistant with a fake first exchange so it behaves as a
 * DeFi / Base blockchain expert from the very first real message.
 * Gemini's generateContent API is stateless — we send the full history
 * on every call, so this framing persists for the whole session.
 */
const history: ConversationTurn[] = [
  {
    role: "user",
    parts: [
      {
        text:
          "You are a DeFi and Base blockchain assistant. " +
          "You help users understand new token launches, liquidity pools, " +
          "Uniswap V3, on-chain risk signals, and the Base ecosystem. " +
          "Be concise, accurate, and technical where appropriate. " +
          "When discussing token addresses or contracts, always remind users " +
          "to verify them on BaseScan before trusting them.",
      },
    ],
  },
  {
    role: "model",
    parts: [
      {
        text:
          "Understood. I'm your DeFi and Base blockchain assistant. " +
          "I can help you with token launches, Uniswap V3 pools, on-chain risk signals, " +
          "and anything else related to the Base ecosystem. What would you like to know?",
      },
    ],
  },
];

// ─── Chat loop ────────────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

console.log("═══════════════════════════════════════════════════════════");
console.log("  Gemini DeFi Assistant");
console.log(`  Model : ${GEMINI_MODEL}`);
console.log("  Topic : Base blockchain, DeFi, token launches, Uniswap V3");
console.log("  Type your question and press Enter. Ctrl+C to exit.");
console.log("═══════════════════════════════════════════════════════════\n");

// Print the prompt manually since we're in non-TTY-safe mode
process.stdout.write("You: ");

rl.on("line", async (line) => {
  const userInput = line.trim();

  if (!userInput) {
    process.stdout.write("You: ");
    return;
  }

  // Append the user turn to history
  const userTurn: ConversationTurn = {
    role: "user",
    parts: [{ text: userInput }],
  };
  history.push(userTurn);

  try {
    process.stdout.write("Assistant: ");
    const reply = await callGemini(history);

    // Append the model turn to history so future calls have full context
    history.push({ role: "model", parts: [{ text: reply }] });

    console.log(reply);
    console.log();
  } catch (err) {
    // Remove the dangling unanswered user turn so history stays clean
    history.pop();

    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n[chat] Error: ${message}`);
    console.log("Your question was not saved to history. Please try again.\n");
  }

  process.stdout.write("You: ");
});

rl.on("close", () => {
  console.log("\n[chat] Session ended.");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n[chat] Exiting…");
  rl.close();
});
