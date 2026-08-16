/**
 * chat.ts — interactive on-chain rug-check chat.
 *
 * The user types a message. If it contains a token address (0x…40 hex chars),
 * the agent runs the full pipeline via answerTokenQuestion() and prints the
 * formatted report (which includes the "Your Question" block when a question
 * was asked).
 *
 * If the message has no address, a helpful prompt is printed instead.
 *
 * Required env vars: RPC_URL, GEMINI_API_KEY
 */
import "dotenv/config";
import * as readline from "readline";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { extractAddress, answerTokenQuestion } from "./lib/rugcheck-handler.js";
import { formatRugReport } from "./lib/rugcheck.js";

// ─── Env validation ───────────────────────────────────────────────────────────

function validateEnv(required: string[]): void {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`ERROR: Missing required environment variable(s): ${missing.join(", ")}`);
    console.error("Check your .env file and ensure all required keys are set.");
    process.exit(1);
  }
}
validateEnv(["RPC_URL", "GEMINI_API_KEY"]);

const RPC_URL = process.env.RPC_URL as string;

// ─── RPC client ───────────────────────────────────────────────────────────────

const client = createPublicClient({
  chain: base,
  transport: http(RPC_URL, { retryCount: 3, retryDelay: 1500 }),
});

// ─── Per-message handler ──────────────────────────────────────────────────────

async function handleMessage(userInput: string): Promise<void> {
  const tokenAddress = extractAddress(userInput);

  if (!tokenAddress) {
    console.log(
      "\n  Tip: paste a Base token address (0x…) anywhere in your message and I'll\n" +
      "  run a full on-chain rug check and answer your question about it.\n"
    );
    return;
  }

  console.log(`\n  Token address detected: ${tokenAddress}`);
  console.log("  Resolving Uniswap V3 pool…");
  console.log("  Running on-chain evidence collection + LLM rug check…\n");

  const outcome = await answerTokenQuestion(client as any, tokenAddress, userInput);

  if ("error" in outcome) {
    console.log(`\n  ⚠️  ${outcome.error}\n`);
    return;
  }

  console.log(formatRugReport(outcome.result, outcome.meta));
  console.log();
}

// ─── Chat loop ────────────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

console.log("═══════════════════════════════════════════════════════════════════");
console.log("  On-Chain Rug Check Chat  (Base Mainnet + Gemini LLM)");
console.log(`  RPC     : ${RPC_URL}`);
console.log(`  Model   : ${process.env.GEMINI_MODEL ?? "gemini-2.0-flash-lite"}`);
console.log("  Usage   : paste a token address in your message and ask anything.");
console.log("            The agent resolves the exact deploy block, collects on-chain");
console.log("            evidence, and answers your question in the rug-check report.");
console.log("  Exit    : Ctrl+C");
console.log("═══════════════════════════════════════════════════════════════════\n");

process.stdout.write("You: ");

rl.on("line", async (line) => {
  const userInput = line.trim();

  if (!userInput) {
    process.stdout.write("You: ");
    return;
  }

  try {
    await handleMessage(userInput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n[chat] Unexpected error: ${message}\n`);
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
