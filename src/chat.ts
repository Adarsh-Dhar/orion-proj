/**
 * chat.ts — interactive on-chain rug-check chat.
 *
 * The user types a message. If it contains a token address (0x…40 hex chars),
 * the agent:
 *   1. Resolves the token's Uniswap V3 pool via resolveTokenPool()
 *   2. Fetches ERC-20 metadata
 *   3. Runs the full LLM rug-check via runRugCheckLLM(), passing the user's
 *      message as userQuestion so Gemini answers it directly in the report
 *   4. Prints formatRugReport() — which now includes the "Your Question" block
 *
 * If the message has no address, a helpful prompt is printed instead.
 *
 * Known limit: deployBlock is approximated as the current block number.
 * The deployer-finder in evidence.ts walks backwards up to 200k blocks
 * (~4 days on Base), so tokens older than ~4 days may not resolve a deployer.
 *
 * Required env vars: RPC_URL, GEMINI_API_KEY
 */
import "dotenv/config";
import * as readline from "readline";
import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import { fetchTokenMetadata } from "./lib/erc20.js";
import { resolveTokenPool } from "./lib/scan-engine.js";
import { runRugCheckLLM, formatRugReport } from "./lib/rugcheck.js";

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

// ─── Address extractor ────────────────────────────────────────────────────────

/** Returns the first 0x-prefixed 40-hex-char address found in a string. */
function extractAddress(text: string): Address | null {
  const match = text.match(/0x[a-fA-F0-9]{40}/);
  return match ? (match[0] as Address) : null;
}

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

  // ── 1. Resolve pool ───────────────────────────────────────────────────────
  console.log("  Resolving Uniswap V3 pool…");
  const resolved = await resolveTokenPool(client as any, tokenAddress);
  if (!resolved) {
    console.log(
      `\n  ⚠️  No Uniswap V3 pool found for ${tokenAddress} on Base.\n` +
      `  The token may not have launched yet, or it uses a non-standard DEX.\n`
    );
    return;
  }
  console.log(`  Pool found: ${resolved.poolAddress}  (paired with ${resolved.pairedLabel})`);

  // ── 2. Fetch ERC-20 metadata ──────────────────────────────────────────────
  console.log("  Fetching token metadata…");
  let meta;
  try {
    meta = await fetchTokenMetadata(client as any, tokenAddress);
  } catch (err) {
    console.error(`\n  [chat] metadata fetch failed: ${err}\n`);
    return;
  }
  console.log(`  Token: ${meta.name} (${meta.symbol})`);

  // ── 3. Approximate deployBlock as current block ───────────────────────────
  // The deployer-finder in evidence.ts walks backwards up to 200k blocks so
  // this works for tokens launched in the last ~4 days on Base.
  const deployBlock = await client.getBlockNumber();

  // ── 4. Run LLM rug check with the user's question ─────────────────────────
  console.log("  Running on-chain evidence collection + LLM rug check…\n");
  let rugResult;
  try {
    rugResult = await runRugCheckLLM(
      client as any,
      tokenAddress,
      resolved.poolAddress,
      resolved.pairedLabel,
      deployBlock,
      meta,
      { userQuestion: userInput }
    );
  } catch (err) {
    console.error(`\n  [chat] rug check failed: ${err}\n`);
    return;
  }

  // ── 5. Print full report (includes "Your Question" block if answer present)
  console.log(formatRugReport(rugResult, meta));
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
console.log("            The agent runs a full evidence scan and answers in-report.");
console.log("  Limit   : deployer resolution works for tokens launched in last ~4 days.");
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
