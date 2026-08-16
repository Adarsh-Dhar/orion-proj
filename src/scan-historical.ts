/**
 * Historical scanner — runs a full rug-check report on every Uniswap V3
 * PoolCreated event in a specific block range.
 *
 * Usage:
 *   npx tsx src/scan-historical.ts [FROM_BLOCK] [TO_BLOCK]
 *
 * Defaults (if no args given):
 *   FROM_BLOCK = 50,045,225  →  2026-08-16 17:00 IST  (11:29 UTC)
 *   TO_BLOCK   = 50,048,826  →  2026-08-16 19:00 IST  (13:30 UTC)
 *
 * The range is split into 500-block chunks to stay inside Infura's
 * eth_getLogs block-range limit. Each chunk is fetched sequentially so we
 * don't hit per-second rate limits.
 */
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
import { runRugCheckLLM, formatRugReport } from "./lib/rugcheck.js";

// ─── Env ─────────────────────────────────────────────────────────────────────

if (!process.env.RPC_URL) {
  console.error("ERROR: RPC_URL is not set in .env");
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY is not set in .env — required for LLM scoring");
  process.exit(1);
}
const RPC_URL = process.env.RPC_URL;

// ─── Args ────────────────────────────────────────────────────────────────────

const DEFAULT_FROM = 50_045_225n;
const DEFAULT_TO   = 50_048_826n;

const FROM_BLOCK: bigint = process.argv[2] ? BigInt(process.argv[2]) : DEFAULT_FROM;
const TO_BLOCK:   bigint = process.argv[3] ? BigInt(process.argv[3]) : DEFAULT_TO;

if (FROM_BLOCK > TO_BLOCK) {
  console.error(`ERROR: FROM_BLOCK (${FROM_BLOCK}) must be ≤ TO_BLOCK (${TO_BLOCK})`);
  process.exit(1);
}

/** Max block range per getLogs call — Infura enforces a 10k limit;
 *  we use 500 to stay well inside it and avoid rate-limit bursts. */
const CHUNK_SIZE = 500n;

// ─── RPC client ───────────────────────────────────────────────────────────────

const client = createPublicClient({
  chain: base,
  transport: http(RPC_URL, { retryCount: 3, retryDelay: 2000 }),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatFee(fee: number): string {
  return `${(fee / 10_000).toFixed(2)}%`;
}

function identifyTokens(token0: Address, token1: Address) {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  const t0known = KNOWN_QUOTE_ASSETS.has(t0);
  const t1known = KNOWN_QUOTE_ASSETS.has(t1);

  if (t0known && !t1known) return { newToken: token1, pairedLabel: QUOTE_ASSET_LABELS[t0] ?? shortAddr(token0) };
  if (t1known && !t0known) return { newToken: token0, pairedLabel: QUOTE_ASSET_LABELS[t1] ?? shortAddr(token1) };
  if (!t0known && !t1known) return { newToken: token0, pairedLabel: "unknown" };
  return { newToken: null, pairedLabel: "ambiguous" }; // both known quote assets
}

/** Brief pause between tokens to avoid hammering the RPC */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const totalBlocks = TO_BLOCK - FROM_BLOCK + 1n;
  const numChunks = Number((totalBlocks + CHUNK_SIZE - 1n) / CHUNK_SIZE);

  // Resolve block timestamps for display
  const [fromBlockData, toBlockData] = await Promise.all([
    client.getBlock({ blockNumber: FROM_BLOCK }),
    client.getBlock({ blockNumber: TO_BLOCK }),
  ]);
  const fromTs = new Date(Number(fromBlockData.timestamp) * 1000).toISOString();
  const toTs   = new Date(Number(toBlockData.timestamp)   * 1000).toISOString();

  console.log(`${"═".repeat(66)}`);
  console.log(`  Historical Pool Scanner — LLM Rug Check (Gemini)`);
  console.log(`  Network   : Base Mainnet (chain ID 8453)`);
  console.log(`  Window    : 5:00 PM – 7:00 PM IST (2026-08-16)`);
  console.log(`  Blocks    : ${FROM_BLOCK.toLocaleString()} → ${TO_BLOCK.toLocaleString()}`);
  console.log(`  Verified  : ${fromTs}  →  ${toTs}`);
  console.log(`  Total     : ${totalBlocks.toLocaleString()} blocks in ${numChunks} chunk(s) of ${CHUNK_SIZE}`);
  console.log(`  Factory   : ${UNISWAP_V3_FACTORY}  [Uniswap V3]`);
  console.log(`  Scoring   : Gemini LLM (${process.env.GEMINI_MODEL ?? "gemini-2.0-flash-lite"})`);
  console.log(`  Started   : ${new Date().toISOString()}`);
  console.log(`${"═".repeat(66)}\n`);

  // ── Collect all PoolCreated logs across chunked getLogs calls ─────────────
  interface PoolCreatedArgs {
    token0: Address;
    token1: Address;
    fee: number;
    tickSpacing: number;
    pool: Address;
  }
  interface PoolLog {
    args: PoolCreatedArgs;
    blockNumber: bigint | null;
    transactionHash: `0x${string}` | null;
  }
  const allLogs: PoolLog[] = [];
  let chunksFetched = 0;
  let chunksFailed  = 0;

  for (let chunkStart = FROM_BLOCK; chunkStart <= TO_BLOCK; chunkStart += CHUNK_SIZE) {
    const chunkEnd = chunkStart + CHUNK_SIZE - 1n < TO_BLOCK
      ? chunkStart + CHUNK_SIZE - 1n
      : TO_BLOCK;

    try {
      const logs = await client.getLogs({
        address: UNISWAP_V3_FACTORY,
        event: POOL_CREATED_ABI[0],
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });
      allLogs.push(...(logs as unknown as PoolLog[]));
      chunksFetched++;
      process.stdout.write(
        `\r  Fetching chunks: ${chunksFetched}/${numChunks} (${allLogs.length} pools so far)   `
      );
    } catch (err) {
      chunksFailed++;
      console.warn(`\n  [scanner] chunk [${chunkStart}–${chunkEnd}] failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Small delay between chunks to avoid hitting rate limits
    if (chunkStart + CHUNK_SIZE <= TO_BLOCK) {
      await sleep(200);
    }
  }

  console.log(`\n\n  Chunk fetch complete: ${chunksFetched}/${numChunks} succeeded, ${chunksFailed} failed`);
  console.log(`  Total pools found  : ${allLogs.length}\n`);

  if (allLogs.length === 0) {
    console.log("  No PoolCreated events found in this window. Exiting.\n");
    return;
  }

  // Sort logs chronologically
  allLogs.sort((a, b) => Number(a.blockNumber! - b.blockNumber!));

  console.log(`${"═".repeat(66)}`);
  console.log(`  Running rug checks on ${allLogs.length} token(s)...`);
  console.log(`${"═".repeat(66)}\n`);

  let processed = 0;
  let skipped    = 0;
  const summary: Array<{ name: string; symbol: string; address: string; verdict: string; score: number; flags: number }> = [];

  for (let i = 0; i < allLogs.length; i++) {
    const log = allLogs[i];
    const { token0, token1, fee, pool } = log.args;
    const txHash    = log.transactionHash ?? "unknown";
    const blockNum  = log.blockNumber ?? TO_BLOCK;
    const blockTime = new Date(
      Number((await client.getBlock({ blockNumber: blockNum })).timestamp) * 1000
    ).toISOString();

    console.log(`  [${i + 1}/${allLogs.length}] Block ${blockNum.toLocaleString()} | ${blockTime}`);
    console.log(`  Pool   : ${pool}`);
    console.log(`  Fee    : ${formatFee(fee)}  |  Tx: ${txHash}`);
    console.log(`  BaseScan: https://basescan.org/tx/${txHash}\n`);

    const { newToken, pairedLabel } = identifyTokens(token0, token1);

    if (!newToken) {
      console.log(`  ⚠️  Ambiguous pair — both tokens are known quote assets. Skipping.\n`);
      console.log(`${"─".repeat(66)}\n`);
      skipped++;
      continue;
    }

    // Fetch metadata
    let meta;
    try {
      meta = await fetchTokenMetadata(client as any, newToken);
    } catch (err) {
      console.error(`  [scanner] metadata fetch failed for ${newToken}: ${err}\n`);
      console.log(`${"─".repeat(66)}\n`);
      skipped++;
      continue;
    }

    // Run rug check (LLM)
    let rugResult;
    try {
      rugResult = await runRugCheckLLM(client as any, newToken, pool, pairedLabel, blockNum, meta);
    } catch (err) {
      console.error(`  [scanner] rug check failed for ${newToken}: ${err}\n`);
      console.log(`${"─".repeat(66)}\n`);
      skipped++;
      continue;
    }

    console.log(formatRugReport(rugResult, meta));
    console.log();

    summary.push({
      name: meta.name,
      symbol: meta.symbol,
      address: newToken,
      verdict: rugResult.verdict,
      score: rugResult.score,
      flags: rugResult.flags.length,
    });
    processed++;

    if (i < allLogs.length - 1) {
      console.log(`${"─".repeat(66)}\n`);
      // 500ms between tokens to be gentle on the RPC during the heavy rug-check phase
      await sleep(500);
    }
  }

  // ── Final summary table ─────────────────────────────────────────────────
  console.log(`\n${"═".repeat(66)}`);
  console.log(`  SCAN COMPLETE — LLM Summary`);
  console.log(`  Scoring   : Gemini LLM (${process.env.GEMINI_MODEL ?? "gemini-2.0-flash-lite"})`);
  console.log(`  Window    : 5:00 PM – 7:00 PM IST (2026-08-16)`);
  console.log(`  Pools     : ${allLogs.length} found  |  ${processed} checked  |  ${skipped} skipped`);
  console.log(`${"═".repeat(66)}\n`);

  if (summary.length === 0) {
    console.log("  No tokens were successfully checked.\n");
    return;
  }

  // Sort by risk score descending
  summary.sort((a, b) => b.score - a.score);

  const verdictEmoji: Record<string, string> = { LOW: "🟢", MEDIUM: "🟡", HIGH: "🟠", CRITICAL: "🔴" };
  console.log(`  ${"#".padEnd(3)} ${"Verdict".padEnd(10)} ${"Score".padEnd(7)} ${"Flags".padEnd(6)} ${"Symbol".padEnd(10)} Address`);
  console.log(`  ${"─".repeat(62)}`);
  for (let i = 0; i < summary.length; i++) {
    const t = summary[i];
    const e = verdictEmoji[t.verdict] ?? "?";
    console.log(
      `  ${String(i + 1).padEnd(3)} ${(e + " " + t.verdict).padEnd(10)} ${String(t.score).padEnd(7)} ${String(t.flags).padEnd(6)} ${t.symbol.slice(0, 9).padEnd(10)} ${t.address}`
    );
  }
  console.log();
}

main().catch((err) => {
  console.error("[scanner] Fatal error:", err);
  process.exit(1);
});
