/**
 * sniper.ts — live token sniper.
 *
 * Scans new Uniswap V3 PoolCreated events on a rolling watermark, delegating
 * the full evidence-collection + LLM rug-check pipeline to scan-engine.ts.
 * The only sniper-specific logic here is the watermark state and the
 * recursive setTimeout loop.
 */
import "dotenv/config";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { UNISWAP_V3_FACTORY } from "./lib/constants.js";
import { scanBlockRange, printSummaryTable } from "./lib/scan-engine.js";

// ─── Env validation ───────────────────────────────────────────────────────────

function validateEnv(required: string[]): void {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`ERROR: Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}
validateEnv(["RPC_URL", "GEMINI_API_KEY"]);

const RPC_URL = process.env.RPC_URL as string;

// ─── Config ───────────────────────────────────────────────────────────────────

/** How long to wait after each scan completes before starting the next (ms) */
const POLL_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * Bootstrap lookback for the very first scan only.
 * Base produces a block every ~2 seconds → 5 min ≈ 150 blocks + 10 buffer.
 */
const BLOCKS_PER_INTERVAL = 160n;

// ─── RPC client ───────────────────────────────────────────────────────────────

const client = createPublicClient({
  chain: base,
  transport: http(RPC_URL, { retryCount: 3, retryDelay: 1500 }),
});

// ─── State ────────────────────────────────────────────────────────────────────

/**
 * Watermark: the last block we successfully scanned.
 * - null  → first run; use the fixed bootstrap lookback
 * - bigint → resume from lastScannedBlock + 1 so no block is ever skipped
 *
 * Only advanced after a successful getLogs call — if the RPC call fails,
 * the next run retries the exact same range.
 */
let lastScannedBlock: bigint | null = null;

// ─── Retry helper ─────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 1,
  delayMs = 3_000
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        console.warn(
          `[sniper] ${label} failed (attempt ${attempt + 1}/${retries + 1}), ` +
          `retrying in ${delayMs / 1000}s…`
        );
        console.warn(`  Reason: ${err instanceof Error ? err.message : String(err)}`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// ─── Core scan window ─────────────────────────────────────────────────────────

async function scanWindow(runNumber: number): Promise<void> {
  const scanTime = new Date().toISOString();

  // Fetch current block with retry — failure skips this cycle without
  // advancing the watermark so the same range is retried next run.
  let toBlock: bigint;
  try {
    toBlock = await withRetry(
      () => client.getBlockNumber(),
      `scan #${runNumber}: getBlockNumber()`
    );
  } catch (err) {
    console.error(
      `[sniper] scan #${runNumber}: getBlockNumber() failed twice — ` +
      `skipping scan, will retry next interval.`
    );
    console.error(`  Reason: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const fromBlock =
    lastScannedBlock !== null
      ? lastScannedBlock + 1n
      : toBlock > BLOCKS_PER_INTERVAL
        ? toBlock - BLOCKS_PER_INTERVAL
        : 0n;

  const windowLabel = lastScannedBlock !== null ? "watermark" : "bootstrap";

  console.log(`\n${"═".repeat(66)}`);
  console.log(`  SNIPER SCAN #${runNumber}  |  ${scanTime}`);
  console.log(
    `  Blocks : ${fromBlock.toLocaleString()} → ${toBlock.toLocaleString()}` +
    `  (${windowLabel}, ${(toBlock - fromBlock + 1n).toLocaleString()} blocks)`
  );
  console.log(`${"═".repeat(66)}\n`);

  // Delegate the full pipeline to the shared scan engine.
  // The watermark is advanced here only on a successful return — if
  // scanBlockRange throws (e.g. the initial getLogs fails), lastScannedBlock
  // stays put and the same range is retried next cycle.
  const { summary, totalPools, processed, skipped } =
    await scanBlockRange(client as any, fromBlock, toBlock);

  // Advance watermark after successful scan
  lastScannedBlock = toBlock;

  if (totalPools > 0) {
    console.log(`  Pools: ${totalPools} found  |  ${processed} checked  |  ${skipped} skipped`);
    printSummaryTable(summary);
  }

  console.log(`  Scan #${runNumber} complete. Next scan in 5 minutes.\n`);
}

// ─── Recursive loop ───────────────────────────────────────────────────────────

/**
 * Schedules the next scan only AFTER the current one finishes (recursive
 * setTimeout, not setInterval) so scans never overlap.
 */
async function loop(runNumber: number): Promise<void> {
  try {
    await scanWindow(runNumber);
  } catch (err) {
    console.error(`[sniper] Unhandled error in scan #${runNumber}: ${err}`);
  }
  setTimeout(() => loop(runNumber + 1), POLL_INTERVAL_MS);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`${"═".repeat(66)}`);
  console.log(`  Base Token Sniper + LLM Rug Check Agent`);
  console.log(`  Network  : Base Mainnet (chain ID 8453)`);
  console.log(`  RPC      : ${RPC_URL}`);
  console.log(`  Factory  : ${UNISWAP_V3_FACTORY}  [Uniswap V3]`);
  console.log(`  Scoring  : Gemini LLM (${process.env.GEMINI_MODEL ?? "gemini-2.0-flash-lite"})`);
  console.log(`  Interval : 5 min after each scan completes (sequential, no overlap)`);
  console.log(`  Started  : ${new Date().toISOString()}`);
  console.log(`${"═".repeat(66)}\n`);

  await scanWindow(1);
  setTimeout(() => loop(2), POLL_INTERVAL_MS);

  process.on("SIGINT", () => {
    console.log("\n[sniper] Shutting down…");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[sniper] Fatal startup error:", err);
  process.exit(1);
});
