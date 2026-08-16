import "dotenv/config";
import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import {
  UNISWAP_V3_FACTORY,
  POOL_CREATED_ABI,
  KNOWN_QUOTE_ASSETS,
  QUOTE_ASSET_LABELS,
} from "./lib/constants.js";
import { fetchTokenMetadata } from "./lib/erc20.js";
import { runRugCheck, formatRugReport } from "./lib/rugcheck.js";

// ─── Env validation ───────────────────────────────────────────────────────────

function validateEnv(required: string[]): void {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`ERROR: Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}
validateEnv(["RPC_URL"]);

const RPC_URL = process.env.RPC_URL as string;

// ─── Config ───────────────────────────────────────────────────────────────────

/** How often to wait between scan completions (ms) */
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatFee(fee: number): string {
  return `${(fee / 10_000).toFixed(2)}%`;
}

function identifyTokens(
  token0: Address,
  token1: Address
): { newToken: Address | null; pairedWith: Address | null; pairedLabel: string } {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  const t0known = KNOWN_QUOTE_ASSETS.has(t0);
  const t1known = KNOWN_QUOTE_ASSETS.has(t1);

  if (t0known && !t1known) {
    return {
      newToken: token1,
      pairedWith: token0,
      pairedLabel: QUOTE_ASSET_LABELS[t0] ?? shortAddr(token0),
    };
  }
  if (t1known && !t0known) {
    return {
      newToken: token0,
      pairedWith: token1,
      pairedLabel: QUOTE_ASSET_LABELS[t1] ?? shortAddr(token1),
    };
  }
  // unknown/unknown — treat token0 as the candidate, flag ambiguity
  return {
    newToken: t0known && t1known ? null : token0,
    pairedWith: t1known ? token1 : null,
    pairedLabel: t1known
      ? (QUOTE_ASSET_LABELS[t1] ?? shortAddr(token1))
      : "unknown",
  };
}

// ─── Core scan function ───────────────────────────────────────────────────────

/**
 * Scan from the watermark (or bootstrap lookback on first run) up to the
 * current block for new PoolCreated events, run the full metadata +
 * rug-check pipeline on each token, and print a structured report.
 *
 * Watermark (`lastScannedBlock`) is only advanced after a successful getLogs,
 * so a failed RPC call causes the same range to be retried next run.
 */
async function scanWindow(runNumber: number): Promise<void> {
  const scanTime = new Date().toISOString();
  const toBlock = await client.getBlockNumber();

  // First run → bootstrap with fixed lookback.
  // All subsequent runs → pick up exactly where we left off.
  const fromBlock =
    lastScannedBlock !== null
      ? lastScannedBlock + 1n
      : toBlock > BLOCKS_PER_INTERVAL
        ? toBlock - BLOCKS_PER_INTERVAL
        : 0n;

  const windowLabel =
    lastScannedBlock !== null ? "watermark" : "bootstrap";

  console.log(`\n${"═".repeat(66)}`);
  console.log(`  SNIPER SCAN #${runNumber}  |  ${scanTime}`);
  console.log(
    `  Blocks : ${fromBlock.toLocaleString()} → ${toBlock.toLocaleString()}` +
    `  (${windowLabel}, ${(toBlock - fromBlock + 1n).toLocaleString()} blocks)`
  );
  console.log(`${"═".repeat(66)}\n`);

  // ── Fetch PoolCreated events in the window ──────────────────────────────
  let logs;
  try {
    logs = await client.getLogs({
      address: UNISWAP_V3_FACTORY,
      event: POOL_CREATED_ABI[0],
      fromBlock,
      toBlock,
    });
  } catch (err) {
    console.error(`[sniper] getLogs failed: ${err}`);
    // Do NOT advance lastScannedBlock — next run retries the same range
    return;
  }

  // Advance the watermark only after a successful fetch
  lastScannedBlock = toBlock;

  if (logs.length === 0) {
    console.log("  No new pools detected in this window.\n");
    return;
  }

  console.log(`  Found ${logs.length} new pool(s) — running rug checks...\n`);

  // ── Process each pool sequentially (avoids RPC hammering) ──────────────
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const { token0, token1, fee, pool } = log.args as {
      token0: Address;
      token1: Address;
      fee: number;
      tickSpacing: number;
      pool: Address;
    };

    const txHash = log.transactionHash ?? "unknown";
    const blockNumber = log.blockNumber ?? toBlock;

    console.log(`  [${i + 1}/${logs.length}] Pool: ${pool}`);
    console.log(`  Fee: ${formatFee(fee)}  |  Tx: ${txHash}`);
    console.log(`  BaseScan: https://basescan.org/tx/${txHash}\n`);

    const { newToken, pairedLabel } = identifyTokens(token0, token1);

    // ── Ambiguous: both tokens are known quote assets ────────────────────
    if (!newToken) {
      console.log(`  ⚠️  Ambiguous pair — both tokens are known quote assets. Skipping.\n`);
      console.log(`${"─".repeat(66)}\n`);
      continue;
    }

    // ── Fetch ERC-20 metadata ────────────────────────────────────────────
    let meta;
    try {
      meta = await fetchTokenMetadata(client, newToken);
    } catch (err) {
      console.error(`  [sniper] metadata fetch failed for ${newToken}: ${err}\n`);
      console.log(`${"─".repeat(66)}\n`);
      continue;
    }

    // ── Run rug check ────────────────────────────────────────────────────
    let rugResult;
    try {
      rugResult = await runRugCheck(
        client,
        newToken,
        pool,
        pairedLabel,
        blockNumber
      );
    } catch (err) {
      console.error(`  [sniper] rug check failed for ${newToken}: ${err}\n`);
      console.log(`${"─".repeat(66)}\n`);
      continue;
    }

    // ── Print full report ────────────────────────────────────────────────
    console.log(formatRugReport(rugResult, meta));
    console.log();

    if (i < logs.length - 1) {
      console.log(`${"─".repeat(66)}\n`);
    }
  }

  console.log(`  Scan #${runNumber} complete. Next scan in 5 minutes.\n`);
}

// ─── Recursive loop ───────────────────────────────────────────────────────────

/**
 * Schedules the next scan only AFTER the current one finishes.
 *
 * This is intentionally a recursive setTimeout rather than setInterval.
 * setInterval fires on a fixed clock regardless of how long the previous
 * run took — if a scan takes >5 minutes (many tokens, many RPC calls),
 * two scans would run concurrently and hammer the RPC endpoint.
 * With setTimeout the 5-minute pause begins after the scan completes,
 * so scans are always sequential no matter how long they take.
 */
async function loop(runNumber: number): Promise<void> {
  try {
    await scanWindow(runNumber);
  } catch (err) {
    // Catch anything scanWindow didn't handle — keep the loop alive
    console.error(`[sniper] Unhandled error in scan #${runNumber}: ${err}`);
  }
  // Schedule next run only after this one is fully done
  setTimeout(() => loop(runNumber + 1), POLL_INTERVAL_MS);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`${"═".repeat(66)}`);
  console.log(`  Base Token Sniper + Rug Check Agent`);
  console.log(`  Network  : Base Mainnet (chain ID 8453)`);
  console.log(`  RPC      : ${RPC_URL}`);
  console.log(`  Factory  : ${UNISWAP_V3_FACTORY}  [Uniswap V3]`);
  console.log(`  Interval : 5 min after each scan completes (sequential, no overlap)`);
  console.log(`  Checks   : ownership · proxy · dev wallet · top-5 holders · liquidity`);
  console.log(`  Started  : ${new Date().toISOString()}`);
  console.log(`${"═".repeat(66)}\n`);

  // First scan runs immediately; loop() takes over for all subsequent scans
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
