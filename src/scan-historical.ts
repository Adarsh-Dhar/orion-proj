/**
 * Historical scanner — runs a full LLM rug-check report on every Uniswap V3
 * PoolCreated event in a specific block range.
 *
 * Usage:
 *   npx tsx src/scan-historical.ts [FROM_BLOCK] [TO_BLOCK]
 *
 * Defaults (if no args given):
 *   FROM_BLOCK = 50,045,225  →  2026-08-16 17:00 IST  (11:29 UTC)
 *   TO_BLOCK   = 50,048,826  →  2026-08-16 19:00 IST  (13:30 UTC)
 */
import "dotenv/config";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { scanBlockRange, printSummaryTable } from "./lib/scan-engine.js";

// ─── Env ──────────────────────────────────────────────────────────────────────

if (!process.env.RPC_URL) {
  console.error("ERROR: RPC_URL is not set in .env");
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY is not set in .env — required for LLM scoring");
  process.exit(1);
}
const RPC_URL = process.env.RPC_URL;

// ─── Block range ──────────────────────────────────────────────────────────────

const DEFAULT_FROM = 50_045_225n;
const DEFAULT_TO   = 50_048_826n;

const FROM_BLOCK: bigint = process.argv[2] ? BigInt(process.argv[2]) : DEFAULT_FROM;
const TO_BLOCK:   bigint = process.argv[3] ? BigInt(process.argv[3]) : DEFAULT_TO;

if (FROM_BLOCK > TO_BLOCK) {
  console.error(`ERROR: FROM_BLOCK (${FROM_BLOCK}) must be ≤ TO_BLOCK (${TO_BLOCK})`);
  process.exit(1);
}

// ─── RPC client ───────────────────────────────────────────────────────────────

const client = createPublicClient({
  chain: base,
  transport: http(RPC_URL, { retryCount: 3, retryDelay: 2000 }),
});

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Resolve block timestamps for the header
  const [fromBlockData, toBlockData] = await Promise.all([
    client.getBlock({ blockNumber: FROM_BLOCK }),
    client.getBlock({ blockNumber: TO_BLOCK }),
  ]);
  const fromTs = new Date(Number(fromBlockData.timestamp) * 1000).toISOString();
  const toTs   = new Date(Number(toBlockData.timestamp)   * 1000).toISOString();

  console.log(`${"═".repeat(66)}`);
  console.log(`  Historical Pool Scanner — LLM Rug Check (Gemini)`);
  console.log(`  Network   : Base Mainnet (chain ID 8453)`);
  console.log(`  Blocks    : ${FROM_BLOCK.toLocaleString()} → ${TO_BLOCK.toLocaleString()}`);
  console.log(`  Verified  : ${fromTs}  →  ${toTs}`);
  console.log(`  Scoring   : Gemini LLM (${process.env.GEMINI_MODEL ?? "gemini-2.0-flash-lite"})`);
  console.log(`  Started   : ${new Date().toISOString()}`);
  console.log(`${"═".repeat(66)}\n`);

  const { summary, totalPools, processed, skipped } =
    await scanBlockRange(client as any, FROM_BLOCK, TO_BLOCK);

  console.log(`  Pools: ${totalPools} found  |  ${processed} checked  |  ${skipped} skipped`);

  printSummaryTable(summary);
}

main().catch((err) => {
  console.error("[scanner] Fatal error:", err);
  process.exit(1);
});
