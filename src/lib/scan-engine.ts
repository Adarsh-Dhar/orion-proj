/**
 * scan-engine.ts — shared block-range scanner used by telegram-bot.ts
 *
 * Exports:
 *   shortAddr(addr)                        — "0x1234…abcd"
 *   formatFee(fee)                         — "0.30%"
 *   identifyTokens(t0, t1)                 — which token is new vs. quote asset
 *   findContractDeployBlock(client, addr)  — binary-search exact deploy block
 *   resolveTokenPool(client, tokenAddress) — find the Uniswap V3 pool for any token
 *   scanBlockRange(client, from, to)       — fetch PoolCreated → rug-check → print report
 */

import { type Address, type PublicClient } from "viem";
import {
  UNISWAP_V3_FACTORY,
  UNISWAP_V4_POOL_MANAGER,
  POOL_CREATED_ABI,
  V4_INITIALIZE_ABI,
  KNOWN_QUOTE_ASSETS,
  QUOTE_ASSET_LABELS,
  type Venue,
} from "./constants.js";
import { fetchTokenMetadata } from "./erc20.js";
import { runRugCheckLLM, formatRugReport } from "./rugcheck.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

/** Max block range per getLogs call.
 *  Alchemy free tier enforces a hard 10-block limit on eth_getLogs.
 *  PAYG / Growth plans allow up to 10k blocks — raise this if you upgrade. */
const CHUNK_SIZE = 10n;

// ─── Shared formatting helpers ────────────────────────────────────────────────

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function formatFee(fee: number): string {
  return `${(fee / 10_000).toFixed(2)}%`;
}

// ─── Token identification ─────────────────────────────────────────────────────

export interface TokenIdentity {
  newToken: Address | null;   // null = both are known quote assets (ambiguous)
  pairedWith: Address | null;
  pairedLabel: string;
}

export function identifyTokens(token0: Address, token1: Address): TokenIdentity {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  const t0known = KNOWN_QUOTE_ASSETS.has(t0);
  const t1known = KNOWN_QUOTE_ASSETS.has(t1);

  if (t0known && !t1known) {
    return { newToken: token1, pairedWith: token0, pairedLabel: QUOTE_ASSET_LABELS[t0] ?? shortAddr(token0) };
  }
  if (t1known && !t0known) {
    return { newToken: token0, pairedWith: token1, pairedLabel: QUOTE_ASSET_LABELS[t1] ?? shortAddr(token1) };
  }
  if (!t0known && !t1known) {
    return { newToken: token0, pairedWith: token1, pairedLabel: "unknown" };
  }
  // both known quote assets — ambiguous
  return { newToken: null, pairedWith: null, pairedLabel: "ambiguous" };
}

// ─── Contract deploy block finder ────────────────────────────────────────────

/**
 * Binary-search the exact block at which a contract was deployed by checking
 * whether `eth_getCode` returns non-empty bytecode.
 *
 * - Before deployment: `getCode` returns "0x" (empty)
 * - After deployment:  `getCode` returns the contract bytecode
 *
 * ~log2(chain_height) RPC calls ≈ 26 calls for Base (~50M blocks).
 * Falls back to `currentBlock` if every call fails (e.g. RPC doesn't support
 * the blockNumber param on eth_getCode — rare but possible on some providers).
 */
export async function findContractDeployBlock(
  client: AnyClient,
  address: Address
): Promise<bigint> {
  const currentBlock = await client.getBlockNumber();

  // Fast-path: if there's no code at the current head, the contract doesn't
  // exist yet — return current block as a best-effort sentinel.
  let headCode: string;
  try {
    headCode = await client.getBytecode({ address }) ?? "0x";
  } catch {
    return currentBlock;
  }
  if (!headCode || headCode === "0x") return currentBlock;

  // Binary search: find the lowest block where bytecode is non-empty.
  let lo = 0n;
  let hi = currentBlock;

  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    let code: string;
    try {
      code = await client.getBytecode({ address, blockNumber: mid }) ?? "0x";
    } catch {
      // If this specific block query fails, bias toward the upper half
      // (assume not yet deployed at mid) so we don't stall the search.
      lo = mid + 1n;
      continue;
    }
    if (code && code !== "0x") {
      hi = mid; // code exists at mid — deploy could be here or earlier
    } else {
      lo = mid + 1n; // no code yet — deploy must be after mid
    }
  }

  return lo;
}

/** Brief pause to be gentle on the RPC */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Pool resolver (used by chat.ts) ─────────────────────────────────────────

/** Minimal Uniswap V3 Factory getPool ABI */
const GET_POOL_ABI = [
  {
    type: "function",
    name: "getPool",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee",    type: "uint24"  },
    ],
    outputs: [{ name: "pool", type: "address" }],
    stateMutability: "view",
  },
] as const;

const QUOTE_ASSETS_LIST = [
  { address: "0x4200000000000000000000000000000000000006" as Address, label: "WETH"  },
  { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address, label: "USDC"  },
  { address: "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca" as Address, label: "USDbC" },
  { address: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb" as Address, label: "DAI"   },
] as const;

const FEE_TIERS = [100, 500, 3_000, 10_000] as const;

const NULL_POOL = "0x0000000000000000000000000000000000000000";

export interface ResolvedPool {
  poolAddress: Address;
  pairedLabel: string;
  pairedAsset: Address; // Add the paired asset address for watchlist
  venue: Venue;
}

/**
 * Try every (quoteAsset × feeTier) combination until we find a real pool.
 * Checks V3 first (factory.getPool), then falls back to V4 (StateView.getSlot0).
 * Returns null if the token has no Uniswap pool on Base.
 */
export async function resolveTokenPool(
  client: AnyClient,
  tokenAddress: Address
): Promise<ResolvedPool | null> {
  // ── V3 path ──────────────────────────────────────────────────────────────
  for (const quote of QUOTE_ASSETS_LIST) {
    for (const fee of FEE_TIERS) {
      try {
        const pool = await client.readContract({
          address: UNISWAP_V3_FACTORY,
          abi: GET_POOL_ABI,
          functionName: "getPool",
          args: [tokenAddress, quote.address, fee],
        }) as Address;
        if (pool && pool.toLowerCase() !== NULL_POOL) {
          return { poolAddress: pool, pairedLabel: quote.label, pairedAsset: quote.address, venue: "v3" };
        }
      } catch {
        // non-existent pair — keep trying
      }
    }
  }

  // ── V4 path — scan recent Initialize events to find a matching pool ──────
  // We look back ~100k blocks (≈ 5 days on Base) for an Initialize event
  // where one of the currencies matches the token address.
  try {
    const currentBlock = await client.getBlockNumber();
    const lookback     = 100_000n;
    const fromBlock    = currentBlock > lookback ? currentBlock - lookback : 0n;
    const CHUNK        = 10n; // Alchemy free tier: max 10 blocks per eth_getLogs

    for (let chunkStart = fromBlock; chunkStart <= currentBlock; chunkStart += CHUNK) {
      const chunkEnd = chunkStart + CHUNK - 1n < currentBlock ? chunkStart + CHUNK - 1n : currentBlock;
      try {
        const logs = await client.getLogs({
          address: UNISWAP_V4_POOL_MANAGER,
          event:   V4_INITIALIZE_ABI[0],
          fromBlock: chunkStart,
          toBlock:   chunkEnd,
        });

        for (const log of logs) {
          const { id, currency0, currency1, fee, tickSpacing, hooks } = log.args as {
            id: `0x${string}`;
            currency0: Address;
            currency1: Address;
            fee: number;
            tickSpacing: number;
            hooks: Address;
          };

          const c0 = currency0.toLowerCase();
          const c1 = currency1.toLowerCase();
          const t  = tokenAddress.toLowerCase();

          if (c0 !== t && c1 !== t) continue;

          // Determine the paired asset and its label
          const pairedAddr   = (c0 === t ? currency1 : currency0);
          const pairedLower  = pairedAddr.toLowerCase();
          const pairedLabel  = QUOTE_ASSET_LABELS[pairedLower] ?? shortAddr(pairedAddr);

          return {
            poolAddress: id as Address,  // poolId used as the pool identifier
            pairedLabel,
            pairedAsset: pairedAddr,
            venue: "v4",
          };
        }
      } catch {
        // chunk failed — keep scanning
      }
      await sleep(150); // respect Alchemy free tier rate limit
    }
  } catch {
    // V4 scan failed entirely — fall through to null
  }

  return null;
}

// ─── Summary type ─────────────────────────────────────────────────────────────

export interface TokenSummary {
  name: string;
  symbol: string;
  address: string;
  verdict: string;
  score: number;
  flags: number;
  venue: Venue;
}

// ─── Core block-range scanner ─────────────────────────────────────────────────

export interface ScanResult {
  summary: TokenSummary[];
  /** Total PoolCreated events found */
  totalPools: number;
  /** Successfully rug-checked */
  processed: number;
  /** Skipped (ambiguous pair, metadata failure, etc.) */
  skipped: number;
}

/** Optional hooks passed to scanBlockRange */
export interface ScanOptions {
  /**
   * Called before evidence collection to check if a token should be skipped.
   * Return true to skip this token (e.g., already posted).
   */
  shouldSkip?: (tokenAddress: string, poolAddress: string, pairedAsset: string) => boolean;
  /**
   * Called once per token immediately after the rug-check report is printed.
   * Errors thrown here are caught and logged — they never abort the scan loop.
   */
  onResult?: (result: import("./rugcheck-types.js").RugCheckResult, meta: {
    name: string; symbol: string; decimals: number;
    totalSupply: bigint; totalSupplyFormatted: string;
  }) => Promise<void>;
  /**
   * Bot state for persistent storage (e.g., deployer history).
   */
  state?: import("./state.js").BotState;
}

/**
 * Fetch all PoolCreated events between fromBlock and toBlock (chunked),
 * run the full metadata + LLM rug-check pipeline on each token, print a
 * structured report per token, and return the summary array.
 *
 * This is the single agent both sniper.ts and scan-historical.ts delegate to.
 */
export async function scanBlockRange(
  client: AnyClient,
  fromBlock: bigint,
  toBlock: bigint,
  opts?: ScanOptions
): Promise<ScanResult> {
  const totalBlocks = toBlock - fromBlock + 1n;
  const numChunks   = Number((totalBlocks + CHUNK_SIZE - 1n) / CHUNK_SIZE);

  // ── Chunked getLogs ───────────────────────────────────────────────────────
  interface V3PoolLog {
    venue: "v3";
    args: { token0: Address; token1: Address; fee: number; tickSpacing: number; pool: Address };
    blockNumber: bigint | null;
    transactionHash: `0x${string}` | null;
  }

  interface V4PoolLog {
    venue: "v4";
    args: { id: `0x${string}`; currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address; sqrtPriceX96: bigint; tick: number };
    blockNumber: bigint | null;
    transactionHash: `0x${string}` | null;
  }

  type PoolLog = V3PoolLog | V4PoolLog;

  const allLogs: PoolLog[] = [];
  let chunksFetched = 0;
  let chunksFailed  = 0;

  for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += CHUNK_SIZE) {
    const chunkEnd = chunkStart + CHUNK_SIZE - 1n < toBlock
      ? chunkStart + CHUNK_SIZE - 1n
      : toBlock;

    try {
      // Fetch V3 PoolCreated events
      const v3Logs = await client.getLogs({
        address: UNISWAP_V3_FACTORY,
        event:   POOL_CREATED_ABI[0],
        fromBlock: chunkStart,
        toBlock:   chunkEnd,
      });

      // Fetch V4 Initialize events
      const v4Logs = await client.getLogs({
        address: UNISWAP_V4_POOL_MANAGER,
        event:   V4_INITIALIZE_ABI[0],
        fromBlock: chunkStart,
        toBlock:   chunkEnd,
      });

      // Tag V3 logs with venue
      const taggedV3Logs = (v3Logs as unknown as V3PoolLog[]).map(log => ({ ...log, venue: "v3" as const }));
      // Tag V4 logs with venue
      const taggedV4Logs = (v4Logs as unknown as V4PoolLog[]).map(log => ({ ...log, venue: "v4" as const }));

      allLogs.push(...taggedV3Logs, ...taggedV4Logs);
      chunksFetched++;
      process.stdout.write(
        `\r  Fetching chunks: ${chunksFetched}/${numChunks} (${allLogs.length} pools so far)   `
      );
    } catch (err) {
      chunksFailed++;
      console.warn(
        `\n  [scan-engine] chunk [${chunkStart}–${chunkEnd}] failed: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (chunkStart + CHUNK_SIZE <= toBlock) await sleep(150); // ~6.5 req/s — well within Alchemy free tier (330 req/s)
  }

  console.log(
    `\n\n  Chunk fetch complete: ${chunksFetched}/${numChunks} succeeded, ${chunksFailed} failed`
  );
  console.log(`  Total pools found  : ${allLogs.length}\n`);

  if (allLogs.length === 0) {
    console.log("  No pool creation events found in this window.\n");
    return { summary: [], totalPools: 0, processed: 0, skipped: 0 };
  }

  // Sort chronologically
  allLogs.sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)));

  console.log(`${"═".repeat(66)}`);
  console.log(`  Running rug checks on ${allLogs.length} token(s)...`);
  console.log(`${"═".repeat(66)}\n`);

  // ── Per-pool pipeline ─────────────────────────────────────────────────────
  let processed = 0;
  let skipped   = 0;
  const summary: TokenSummary[] = [];

  for (let i = 0; i < allLogs.length; i++) {
    const log = allLogs[i];
    const venue = log.venue;
    const txHash   = log.transactionHash ?? "unknown";
    const blockNum = log.blockNumber ?? toBlock;

    // Resolve block timestamp for display
    let blockTime = "";
    try {
      const blk = await client.getBlock({ blockNumber: blockNum });
      blockTime = new Date(Number(blk.timestamp) * 1000).toISOString();
    } catch {
      blockTime = "(timestamp unavailable)";
    }

    let token0: Address, token1: Address, fee: number, poolAddress: Address;
    let hookAddress: string | null = null;
    let v4PoolParams: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address } | undefined;

    if (venue === "v3") {
      const v3Log = log as V3PoolLog;
      token0 = v3Log.args.token0;
      token1 = v3Log.args.token1;
      fee = v3Log.args.fee;
      poolAddress = v3Log.args.pool;
    } else {
      // V4
      const v4Log = log as V4PoolLog;
      token0 = v4Log.args.currency0;
      token1 = v4Log.args.currency1;
      fee = v4Log.args.fee;
      // For V4, use the poolId as the pool identifier (bytes32 cast to Address)
      poolAddress = v4Log.args.id as Address;
      hookAddress = v4Log.args.hooks;
      v4PoolParams = {
        currency0:   v4Log.args.currency0,
        currency1:   v4Log.args.currency1,
        fee:         v4Log.args.fee,
        tickSpacing: v4Log.args.tickSpacing,
        hooks:       v4Log.args.hooks,
      };
    }

    console.log(`  [${i + 1}/${allLogs.length}] Block ${blockNum.toLocaleString()} | ${blockTime}`);
    console.log(`  Venue  : ${venue.toUpperCase()}`);
    console.log(`  Pool   : ${poolAddress}`);
    console.log(`  Fee    : ${formatFee(fee)}  |  Tx: ${txHash}`);
    console.log(`  BaseScan: https://basescan.org/tx/${txHash}\n`);

    const { newToken, pairedLabel } = identifyTokens(token0, token1);

    if (!newToken) {
      console.log(`  ⚠️  Ambiguous pair — both tokens are known quote assets. Skipping.\n`);
      console.log(`${"─".repeat(66)}\n`);
      skipped++;
      continue;
    }

    // Early skip check (e.g., already posted) before expensive evidence collection
    if (opts?.shouldSkip && opts.shouldSkip(newToken, poolAddress, pairedLabel)) {
      console.log(`  [scan-engine] Skipping ${newToken} — shouldSkip returned true\n`);
      console.log(`${"─".repeat(66)}\n`);
      skipped++;
      continue;
    }

    // Fetch ERC-20 metadata
    let meta;
    try {
      meta = await fetchTokenMetadata(client, newToken);
    } catch (err) {
      console.error(`  [scan-engine] metadata fetch failed for ${newToken}: ${err}\n`);
      console.log(`${"─".repeat(66)}\n`);
      skipped++;
      continue;
    }

    // Run LLM rug check
    let rugResult;
    try {
      rugResult = await runRugCheckLLM(client, newToken, poolAddress, pairedLabel, blockNum, meta, {
        mode: "alert",
        state: opts?.state,
        venue,
        hookAddress,
        v4PoolParams,
      });
    } catch (err) {
      console.error(`  [scan-engine] rug check failed for ${newToken}: ${err}\n`);
      console.log(`${"─".repeat(66)}\n`);
      skipped++;
      continue;
    }

    console.log(formatRugReport(rugResult, meta));
    console.log();

    // Invoke the optional callback (e.g. tweet the result) — errors are
    // isolated so one bad tweet never aborts the rest of the scan.
    if (opts?.onResult) {
      try {
        await opts.onResult(rugResult, meta);
      } catch (err) {
        console.error(`  [scan-engine] onResult callback failed for ${newToken}: ${err}`);
      }
    }

    summary.push({
      name:    meta.name,
      symbol:  meta.symbol,
      address: newToken,
      verdict: rugResult.verdict,
      score:   rugResult.score,
      flags:   rugResult.flags.length,
      venue:   venue,
    });
    processed++;

    if (i < allLogs.length - 1) {
      console.log(`${"─".repeat(66)}\n`);
      await sleep(500); // gentle on RPC during heavy rug-check phase
    }
  }

  return { summary, totalPools: allLogs.length, processed, skipped };
}
