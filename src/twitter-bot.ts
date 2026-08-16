/**
 * twitter-bot.ts — auto-posting sniper bot.
 *
 * Scans new Uniswap V3 pools on Base every 5 min, runs the full LLM rug-check
 * pipeline, and tweets HIGH/CRITICAL results as a thread.
 *
 * Required env vars:
 *   RPC_URL, GEMINI_API_KEY,
 *   TWITTER_API_KEY, TWITTER_API_SECRET,
 *   TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET
 *   TWITTER_DRY_RUN=true   (set to "false" to post for real)
 */

import "dotenv/config";
import { createPublicClient, http } from "viem";
import { base }                     from "viem/chains";
import { scanBlockRange, printSummaryTable } from "./lib/scan-engine.js";
import { formatTweetThread }        from "./lib/tweet-format.js";
import { postThread }               from "./lib/twitter.js";
import { loadState, saveState, alreadyPosted, markPosted } from "./lib/state.js";
import { UNISWAP_V3_FACTORY }       from "./lib/constants.js";

// ─── Env validation ───────────────────────────────────────────────────────────

function validateEnv(required: string[]): void {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`ERROR: Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

validateEnv(["RPC_URL", "GEMINI_API_KEY"]);

if (process.env.TWITTER_DRY_RUN !== "true") {
  validateEnv([
    "TWITTER_USER_ACCESS_TOKEN",
  ]);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const SNIPER_INTERVAL_MS  = 5 * 60_000;  // 5 min
/**
 * Block lookback per tick — mirrors scan-historical.ts's default range.
 * 50,048,826 - 50,045,225 = 3,601 blocks ≈ 2 hours of Base history.
 * Using a large window means each tick catches everything even if pools
 * are sparse, and the watermark prevents double-processing.
 */
const BLOCKS_PER_INTERVAL = 3_600n;

/** Post every token regardless of verdict. */
const POST_VERDICTS = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

// ─── RPC client ───────────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL!;
const client  = createPublicClient({
  chain: base,
  transport: http(RPC_URL, { retryCount: 3, retryDelay: 1500 }),
});

// ─── State ────────────────────────────────────────────────────────────────────

const state = loadState();
let lastScannedBlock: bigint | null = null;
let sniperRun = 0;

// ─── Sniper tick ──────────────────────────────────────────────────────────────

async function sniperTick(): Promise<void> {
  sniperRun++;
  const runLabel = `#${sniperRun}`;
  const now      = new Date().toISOString();

  let toBlock: bigint;
  try {
    toBlock = await client.getBlockNumber();
  } catch (err) {
    console.error(`[sniper ${runLabel}] getBlockNumber() failed — skipping: ${err}`);
    return;
  }

  const fromBlock   = lastScannedBlock !== null
    ? lastScannedBlock + 1n
    : toBlock - BLOCKS_PER_INTERVAL;
  const windowLabel = lastScannedBlock !== null ? "watermark" : "bootstrap";

  console.log(`\n${"═".repeat(66)}`);
  console.log(`  SNIPER ${runLabel}  |  ${now}`);
  console.log(`  Blocks : ${fromBlock.toLocaleString()} → ${toBlock.toLocaleString()}  (${windowLabel})`);
  console.log(`${"═".repeat(66)}\n`);

  const { summary, totalPools, processed, skipped } = await scanBlockRange(
    client as any,
    fromBlock,
    toBlock,
    {
      onResult: async (result, meta) => {
        // Skip tokens we've already tweeted about
        if (alreadyPosted(state, result.tokenAddress)) {
          console.log(`  [bot] Already posted ${result.tokenAddress} — skipping`);
          return;
        }
        // Only tweet noteworthy verdicts
        if (!POST_VERDICTS.has(result.verdict)) {
          console.log(`  [bot] ${result.verdict} for ${result.tokenAddress} — below threshold, skipping`);
          return;
        }
        const thread = formatTweetThread(result, meta);
        console.log(`  [bot] Posting ${thread.length}-tweet thread for ${result.tokenAddress} (${result.verdict})`);
        await postThread(thread);
        markPosted(state, result.tokenAddress);
      },
    }
  );

  // Advance watermark only after a successful scan
  lastScannedBlock = toBlock;

  if (totalPools > 0) {
    console.log(`  Pools: ${totalPools} found | ${processed} checked | ${skipped} skipped`);
    printSummaryTable(summary);
  }

  console.log(`  Sniper ${runLabel} complete. Next in 5 min.\n`);
}

// ─── Recursive loop ───────────────────────────────────────────────────────────

async function loop(fn: () => Promise<void>, intervalMs: number): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[sniper] Unhandled error: ${err}`);
  }
  setTimeout(() => loop(fn, intervalMs), intervalMs);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dryRun = process.env.TWITTER_DRY_RUN !== "false";

  console.log(`${"═".repeat(66)}`);
  console.log(`  Watchdog Twitter Bot`);
  console.log(`  Network  : Base Mainnet (chain ID 8453)`);
  console.log(`  RPC      : ${RPC_URL}`);
  console.log(`  Factory  : ${UNISWAP_V3_FACTORY}  [Uniswap V3]`);
  console.log(`  Scoring  : Gemini LLM (${process.env.GEMINI_MODEL ?? "gemini-2.0-flash-lite"})`);
  console.log(`  Interval : 5 min after each scan completes`);
  console.log(`  Filter   : posting ALL verdicts (LOW, MEDIUM, HIGH, CRITICAL)`);
  console.log(`  Dry run  : ${dryRun ? "YES — tweets logged, not posted" : "NO — posting live"}`);
  console.log(`  Started  : ${new Date().toISOString()}`);
  console.log(`${"═".repeat(66)}\n`);

  // Run the first scan immediately, then schedule the recurring loop
  await sniperTick().catch((err) =>
    console.error(`[sniper] Fatal on first run: ${err}`)
  );
  setTimeout(() => loop(sniperTick, SNIPER_INTERVAL_MS), SNIPER_INTERVAL_MS);

  process.on("SIGINT", () => {
    console.log("\n[bot] Shutting down — saving state…");
    saveState(state);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[bot] Fatal startup error:", err);
  process.exit(1);
});
