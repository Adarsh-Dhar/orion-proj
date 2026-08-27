/**
 * telegram-bot.ts — auto-posting sniper bot for Telegram.
 *
 * Scans new Uniswap V3 pools on Base every 5 min, runs the full LLM rug-check
 * pipeline, and sends HIGH/CRITICAL results to a Telegram channel.
 *
 * Also handles chat messages from users who want to query token addresses.
 *
 * Required env vars:
 *   RPC_URL, GEMINI_API_KEY,
 *   TELEGRAM_BOT_TOKEN,
 *   TELEGRAM_NOTIFY_CHAT_ID — channel/group for sniper alerts
 */

import "dotenv/config";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { bot } from "./lib/telegram.js";
import { scanBlockRange } from "./lib/scan-engine.js";
import { sendReport } from "./lib/telegram.js";
import { registerChatHandler } from "./lib/chat-handler.js";
import { registerInlineHandler } from "./lib/inline-handler.js";
import { formatAlertCard } from "./lib/rugcheck.js";
import { loadState, saveState, alreadyPosted, markPosted, addToWatchlist, getWatchlistTokens, recordLiquiditySnapshot } from "./lib/state.js";
import { checkLiquidityDelta } from "./lib/evidence.js";
import { UNISWAP_V3_FACTORY, UNISWAP_V4_POOL_MANAGER } from "./lib/utils/constants.js";
import { initQuoteAssets } from "./lib/quote-assets.js";

// ─── Env validation ───────────────────────────────────────────────────────────

function validateEnv(required: string[]): void {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`ERROR: Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

validateEnv(["RPC_URL", "GEMINI_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_NOTIFY_CHAT_ID"]);

// Warn early about optional-but-visible config gaps so they don't fail silently
if (!process.env.FRONTEND_BASE_URL) {
  console.warn("[config] FRONTEND_BASE_URL not set — analysis links will be omitted from alerts");
}
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.warn("[config] Upstash Redis credentials not set — analysis storage disabled (links will be omitted)");
}

// ─── Config ───────────────────────────────────────────────────────────────────

const SNIPER_INTERVAL_MS = 5 * 60_000; // 5 min
const WATCHLIST_MAX_AGE_MINUTES = 120; // 2 hours
/**
 * Safety ceiling only — NOT the normal per-tick window.
 *
 * Normal operation: sniperTick() always scans lastScannedBlock → currentBlock,
 * i.e. every block produced since the previous tick. On Base (~2s/block) a
 * healthy 5-min cadence means that's naturally ~150 blocks — there is no
 * fixed "5-minute window" constant needed for the happy path.
 *
 * This constant only kicks in for the pathological case where fromBlock is
 * somehow ahead of currentBlock (clock skew / bad state) and we need to pick
 * a fallback lookback. Kept small on purpose — this bot intentionally does
 * NOT backfill large historical ranges (see main()'s startup reset).
 */
const BLOCKS_PER_INTERVAL = 200n; // ~150 blocks/5min on Base + buffer

/** Post every token regardless of verdict. */
const POST_VERDICTS = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

// ─── RPC client ───────────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL!;
const client = createPublicClient({
  chain: base,
  transport: http(RPC_URL, { retryCount: 5, retryDelay: 2000 }),
});

/**
 * Wrapper around client.getBlockNumber() with manual exponential backoff.
 * The viem built-in retryCount handles server errors (5xx), but transient
 * network errors like ECONNRESET / fetch failed can still slip through.
 * This adds an outer retry layer so a brief connectivity blip doesn't crash
 * the whole sniper loop.
 */
async function getBlockNumberWithRetry(maxAttempts = 5): Promise<bigint> {
  let delay = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await client.getBlockNumber();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      console.warn(`[bot] getBlockNumber failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms… ${err instanceof Error ? err.message : err}`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000); // cap at 30s
    }
  }
  throw new Error("getBlockNumber: unreachable");
}

// ─── State ────────────────────────────────────────────────────────────────────

const state = loadState();

// ─── Register chat handler ────────────────────────────────────────────────────

registerChatHandler(bot, client as any, state);
registerInlineHandler(bot, client as any, state);
let lastScannedBlock: bigint | null = state.lastScannedBlock ? BigInt(state.lastScannedBlock) : 0n;
let sniperRun = 0;

// ─── Sniper tick ──────────────────────────────────────────────────────────────

async function sniperTick(): Promise<void> {
  sniperRun++;
  const runLabel = `#${sniperRun}`;
  const now = new Date().toISOString();

  // Get current block to ensure we don't scan ahead of the chain
  const currentBlock = await getBlockNumberWithRetry();

  // Ensure we don't scan ahead of the current block
  let fromBlock = lastScannedBlock ?? currentBlock;
  if (fromBlock > currentBlock) {
    console.log(`[bot] Warning: fromBlock ${fromBlock} is ahead of current block ${currentBlock}, resetting`);
    fromBlock = currentBlock - BLOCKS_PER_INTERVAL;
    if (fromBlock < 0n) fromBlock = 0n;
    lastScannedBlock = fromBlock;
    state.lastScannedBlock = fromBlock.toString();
    saveState(state);
  }

  // Always scan every block produced since the last tick — no artificial cap.
  // In steady state (bot ticking every ~5 min) this naturally covers "the
  // past 5 minutes"; if a tick runs long, it still catches up fully instead
  // of silently dropping blocks.
  const toBlock = currentBlock;

  // If fromBlock == toBlock, no new blocks to scan
  if (fromBlock >= currentBlock) {
    console.log(`\n${"═".repeat(66)}`);
    console.log(`  SNIPER ${runLabel}  |  ${now}`);
    console.log(`  No new blocks to scan (current: ${currentBlock.toLocaleString()}, last scanned: ${fromBlock.toLocaleString()})`);
    console.log(`${"═".repeat(66)}\n`);
    return;
  }

  const windowLabel = "interval";

  console.log(`\n${"═".repeat(66)}`);
  console.log(`  SNIPER ${runLabel}  |  ${now}`);
  console.log(`  Blocks : ${fromBlock.toLocaleString()} → ${toBlock.toLocaleString()}  (${windowLabel})`);
  console.log(`  Current block: ${currentBlock.toLocaleString()}`);
  console.log(`${"═".repeat(66)}\n`);

  const { totalPools, processed, skipped } = await scanBlockRange(
    client as any,
    fromBlock,
    toBlock,
    {
      shouldSkip: (tokenAddress, poolAddress, pairedAsset) => {
        // New tokens get full check
        if (!alreadyPosted(state, tokenAddress)) {
          return false;
        }
        
        // Backfill: this token was posted before the watchlist existed, or before
        // this restart re-discovered it — make sure it's still being monitored.
        // Default to v3 for backfilled entries (historic tokens are v3)
        addToWatchlist(state, tokenAddress, poolAddress, pairedAsset, "v3");
        
        console.log(`  [bot] Already posted ${tokenAddress} — skipping full check (watchlist ensured)`);
        return true;
      },
      onResult: async (result, meta) => {
        // Only post noteworthy verdicts
        if (!POST_VERDICTS.has(result.verdict)) {
          console.log(`  [bot] ${result.verdict} for ${result.tokenAddress} — below threshold, skipping`);
          return;
        }
        console.log(`  [bot] Sending alert for ${result.tokenAddress} (${result.verdict})`);
        await sendReport(
          process.env.TELEGRAM_NOTIFY_CHAT_ID!,
          formatAlertCard(result, meta)
        );
        markPosted(state, result.tokenAddress);
        addToWatchlist(state, result.tokenAddress, result.poolAddress, result.pairedAsset, result.venue);
      },
      state: state,
    }
  );

  // Advance watermark only after a successful scan, but never ahead of current block
  lastScannedBlock = toBlock;
  if (lastScannedBlock > currentBlock) {
    lastScannedBlock = currentBlock;
  }
  state.lastScannedBlock = lastScannedBlock.toString();
  saveState(state);

  if (totalPools > 0) {
    console.log(`  Pools: ${totalPools} found | ${processed} checked | ${skipped} skipped`);
  }

  // ── Liquidity recheck for watchlist tokens ────────────────────────────────
  const watchlistEntries = getWatchlistTokens(state, WATCHLIST_MAX_AGE_MINUTES);
  console.log(`  Watchlist check: ${watchlistEntries.length} tokens (max age: ${WATCHLIST_MAX_AGE_MINUTES} min)`);
  if (watchlistEntries.length > 0) {
    console.log(`  Checking liquidity for ${watchlistEntries.length} watchlist tokens...`);
    for (const entry of watchlistEntries) {
      try {
        const deltaResult = await checkLiquidityDelta(
          client as any,
          entry.poolAddress as any,
          state,
          entry.venue          // V3: reads pool.liquidity(); V4: reads StateView.getLiquidity(poolId)
        );
        // Save the current snapshot for next comparison
        if (deltaResult.currentSnapshot) {
          recordLiquiditySnapshot(state, entry.poolAddress, deltaResult.currentSnapshot);
        }
        if (deltaResult.liquidityDeltaPct !== null && deltaResult.liquidityDeltaPct < -30) {
          // Significant liquidity drop detected
          const emoji = deltaResult.liquidityDeltaPct < -70 ? "🔴" : "🟠";
          const severity = deltaResult.liquidityDeltaPct < -70 ? "CRITICAL" : "HIGH";
          const message = `${emoji} Liquidity Alert — ${entry.tokenAddress.slice(0,8)}…${entry.tokenAddress.slice(-4)}\n` +
            `Liquidity dropped ${Math.abs(deltaResult.liquidityDeltaPct).toFixed(1)}% since last check (${deltaResult.snapshotAgeMinutes} min ago)\n` +
            `https://basescan.org/address/${entry.tokenAddress}`;
          
          await sendReport(process.env.TELEGRAM_NOTIFY_CHAT_ID!, message);
          console.log(`  [watchlist] 🚨 Liquidity drop detected for ${entry.tokenAddress}: ${deltaResult.liquidityDeltaPct.toFixed(1)}%`);
        } else {
          console.log(`  [watchlist] ${entry.tokenAddress}: ${deltaResult.liquidityDeltaPct !== null ? deltaResult.liquidityDeltaPct.toFixed(1) + '%' : 'no data'}`);
        }
      } catch (err) {
        console.error(`  [watchlist] Error checking ${entry.tokenAddress}: ${err}`);
      }
    }
    // Batch save after the loop to avoid excessive file writes
    saveState(state);
  } else {
    console.log(`  [watchlist] No tokens to monitor (watchlist empty or all entries expired)`);
  }

  console.log(`  Sniper ${runLabel} complete.\n`);
}

// ─── Recursive loop ───────────────────────────────────────────────────────────

async function loop(fn: () => Promise<void>, intervalMs: number): Promise<void> {
  const startedAt = Date.now();
  try {
    await fn();
  } catch (err) {
    console.error(`[sniper] Unhandled error: ${err}`);
  }
  const elapsed = Date.now() - startedAt;
  // Fire the next tick on a fixed cadence: intervalMs after the *start* of
  // this tick, not intervalMs after it finished. If a tick somehow runs
  // longer than intervalMs, fire again immediately rather than waiting
  // another full interval on top of the overrun.
  const nextDelay = Math.max(0, intervalMs - elapsed);
  setTimeout(() => loop(fn, intervalMs), nextDelay);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load the live quote-asset list before any scanning starts — near-instant
  // if a disk cache exists, otherwise does one blocking fetch so the first
  // scan still has full coverage. Falls back to the static list on failure.
  await initQuoteAssets();

  // Always start from the current block at boot — never resume a historical
  // backlog from disk. This bot is only meant to watch new pools going
  // forward; any stored watermark from a previous run is discarded so a
  // restart never triggers a multi-thousand-block backfill scan.
  const currentBlock = await getBlockNumberWithRetry();
  console.log(`[bot] Starting fresh from current block ${currentBlock} (no historical backfill)`);
  lastScannedBlock = currentBlock;
  state.lastScannedBlock = lastScannedBlock.toString();
  saveState(state);

  console.log(`${"═".repeat(66)}`);
  console.log(`  RugHound Telegram Bot`);
  console.log(`  Network  : Base Mainnet (chain ID 8453)`);
  console.log(`  RPC      : ${RPC_URL}`);
  console.log(`  V3 Factory: ${UNISWAP_V3_FACTORY}`);
  console.log(`  V4 PoolMgr: ${UNISWAP_V4_POOL_MANAGER}`);
  console.log(`  Scoring  : Gemini LLM (${process.env.GEMINI_MODEL ?? "gemini-2.0-flash-lite"})`);
  console.log(`  Interval : every 5 min (fixed cadence, drift-corrected)`);
  console.log(`  Filter   : posting ALL verdicts (LOW, MEDIUM, HIGH, CRITICAL)`);
  console.log(`  Notify   : ${process.env.TELEGRAM_NOTIFY_CHAT_ID}`);
  console.log(`  Started  : ${new Date().toISOString()}`);
  console.log(`${"═".repeat(66)}\n`);

  // Run the first scan immediately, then schedule the recurring loop
  // Register command menu for Telegram's native "/" autocomplete
  await bot.api.setMyCommands([
    { command: "start", description: "Show welcome message" },
    { command: "help", description: "Show usage instructions" },
    { command: "full", description: "Get full detailed report" },
  ]).catch((err) => console.error("[bot] Failed to set commands:", err));

  // Start grammy polling FIRST so chat messages are handled immediately,
  // even while the sniper is running its first (potentially long) scan.
  bot.start({
    allowed_updates: ["message", "callback_query", "inline_query"], // Only process relevant updates
    drop_pending_updates: true, // Drop any pending updates on startup
  });
  console.log("[bot] Telegram polling started");

  // Kick off the recurring sniper loop in the background — do NOT await so
  // bot.start() can begin receiving messages right away. loop() itself runs
  // the first tick immediately and then schedules every subsequent tick on
  // a fixed ~5-min cadence (see loop()'s drift-correction above).
  loop(sniperTick, SNIPER_INTERVAL_MS).catch((err) =>
    console.error(`[sniper] Fatal loop error: ${err}`)
  );

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