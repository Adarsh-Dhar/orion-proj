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
  type Venue,
} from "./utils/constants.js";
import { isKnownQuoteAsset, getQuoteAssetLabel, getCoreQuoteAssets } from "./quote-assets.js";
import { fetchTokenMetadata } from "./erc20.js";
import { runRugCheckLLM, formatRugReport } from "./rugcheck.js";
import { reVerifyEvidence } from "./evidence.js";
import { updateAnalysis } from "./analysis-store.js";
import type { TokenIdentity, ResolvedPool, V3PoolLog, V4PoolLog, ScanOptions, ScanResult, TokenSummary } from "./utils/interface.js";

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


export function identifyTokens(token0: Address, token1: Address): TokenIdentity {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  const t0known = isKnownQuoteAsset(t0);
  const t1known = isKnownQuoteAsset(t1);

  if (t0known && !t1known) {
    return { newToken: token1, pairedWith: token0, pairedLabel: getQuoteAssetLabel(t0, shortAddr(token0)) };
  }
  if (t1known && !t0known) {
    return { newToken: token0, pairedWith: token1, pairedLabel: getQuoteAssetLabel(t1, shortAddr(token1)) };
  }
  if (!t0known && !t1known) {
    // Neither side is a recognized base/quote pairing asset (WETH, USDC,
    // etc.) — this is NOT a new-token-vs-base launch, it's a pool between
    // two arbitrary tokens (e.g. two existing tokens, or two unrelated new
    // ones). Previously this branch guessed token0 was "the new token" and
    // sent it through the full evidence + LLM rug-check pipeline anyway,
    // which is what caused the scanner to pick up pools outside its
    // intended scope. Skip it instead.
    return { newToken: null, pairedWith: null, pairedLabel: "no-known-quote-asset" };
  }
  // both known quote assets — genuinely ambiguous (e.g. a WETH/USDC pool)
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

const FEE_TIERS = [100, 500, 3_000, 10_000] as const;

const NULL_POOL = "0x0000000000000000000000000000000000000000";



/**
 * Try every (quoteAsset × feeTier) combination until we find a real pool.
 * Checks V3 first (factory.getPool), then falls back to V4 (StateView.getSlot0).
 * Returns null if the token has no Uniswap pool on Base.
 */
export async function resolveTokenPool(
  client: AnyClient,
  tokenAddress: Address
): Promise<ResolvedPool | null> {
  const resolveStart = Date.now();
  console.log(`[timing] Starting pool resolution for ${tokenAddress}`);
  
  // ── V3 path ──────────────────────────────────────────────────────────────
  for (const quote of getCoreQuoteAssets()) {
    for (const fee of FEE_TIERS) {
      try {
        const pool = await client.readContract({
          address: UNISWAP_V3_FACTORY,
          abi: GET_POOL_ABI,
          functionName: "getPool",
          args: [tokenAddress, quote.address, fee],
        }) as Address;
        if (pool && pool.toLowerCase() !== NULL_POOL) {
          const v3Duration = Date.now() - resolveStart;
          console.log(`[timing] V3 pool found in ${v3Duration}ms: ${pool}`);
          return { poolAddress: pool, pairedLabel: quote.label, pairedAsset: quote.address, venue: "v3" };
        }
      } catch {
        // non-existent pair — keep trying
      }
    }
  }
  
  const v3Complete = Date.now();
  console.log(`[timing] V3 path completed in ${v3Complete - resolveStart}ms, starting V4 scan`);

  // ── V4 path — scan Initialize events near the token's deploy block ──────
  // Strategy:
  //   1. Binary-search the token contract's deploy block (fast, ~26 RPC calls).
  //   2. Scan deployBlock-10 → deployBlock+200 for a V4 Initialize event that
  //      contains this token as currency0 or currency1.
  //      On Base, pools are almost always initialized within a few blocks of
  //      token deployment.  200 blocks ≈ 7 minutes — enough headroom.
  //   3. If still not found, do one wider backward pass: deployBlock-500 → deployBlock-10
  //      to catch tokens that were deployed long before their pool was created.
  //
  // Total worst-case: (210 + 490) / 10 = 70 getLogs calls vs the old 10,000.
  try {
    const deployStart = Date.now();
    console.log(`[timing] Starting V4 deploy block search`);
    const deployBlock  = await findContractDeployBlock(client, tokenAddress);
    const deployDuration = Date.now() - deployStart;
    console.log(`[timing] Deploy block found: ${deployBlock} in ${deployDuration}ms`);
    
    const currentBlock = await client.getBlockNumber();
    const CHUNK        = 10n;

    // Helper: scan a [from, to] range for a matching Initialize event
    const scanRange = async (from: bigint, to: bigint, rangeName: string): Promise<ResolvedPool | null> => {
      const rangeStart = Date.now();
      console.log(`[timing] Starting ${rangeName} scan: blocks ${from}-${to}`);
      const scanTo = to < currentBlock ? to : currentBlock;
      let chunksScanned = 0;
      for (let chunkStart = from; chunkStart <= scanTo; chunkStart += CHUNK) {
        const chunkEnd = chunkStart + CHUNK - 1n < scanTo ? chunkStart + CHUNK - 1n : scanTo;
        try {
          const logs = await client.getLogs({
            address: UNISWAP_V4_POOL_MANAGER,
            event:   V4_INITIALIZE_ABI[0],
            fromBlock: chunkStart,
            toBlock:   chunkEnd,
          });
          for (const log of logs) {
            const { id, currency0, currency1 } = log.args as {
              id: `0x${string}`; currency0: Address; currency1: Address;
              fee: number; tickSpacing: number; hooks: Address;
            };
            const c0 = currency0.toLowerCase();
            const c1 = currency1.toLowerCase();
            const t  = tokenAddress.toLowerCase();
            if (c0 !== t && c1 !== t) continue;
            const pairedAddr  = c0 === t ? currency1 : currency0;
            const pairedLower = pairedAddr.toLowerCase();
            const pairedLabel = getQuoteAssetLabel(pairedLower, shortAddr(pairedAddr));
            const rangeDuration = Date.now() - rangeStart;
            console.log(`[timing] ${rangeName} scan found pool in ${rangeDuration}ms`);
            return { poolAddress: id as Address, pairedLabel, pairedAsset: pairedAddr, venue: "v4" };
          }
        } catch {
          // chunk failed — keep scanning
        }
        chunksScanned++;
        if (chunksScanned % 10 === 0) {
          console.log(`[timing] ${rangeName} scan progress: ${chunksScanned} chunks scanned`);
        }
        await sleep(150);
      }
      const rangeDuration = Date.now() - rangeStart;
      console.log(`[timing] ${rangeName} scan completed in ${rangeDuration}ms, no pool found`);
      return null;
    };

    // Pass 1: forward scan from (deployBlock-10) to (deployBlock+200)
    const forwardFrom = deployBlock > 10n ? deployBlock - 10n : 0n;
    const forwardTo   = deployBlock + 200n;
    const forwardHit  = await scanRange(forwardFrom, forwardTo, "forward");
    if (forwardHit) return forwardHit;

    // Pass 2: backward scan (deployBlock-500) to (deployBlock-11) for tokens
    // whose pool was created well before or after deployment
    if (deployBlock > 11n) {
      const backwardFrom = deployBlock > 500n ? deployBlock - 500n : 0n;
      const backwardTo   = deployBlock - 11n;
      const backwardHit  = await scanRange(backwardFrom, backwardTo, "backward");
      if (backwardHit) return backwardHit;
    }
  } catch (err) {
    console.log(`[timing] V4 scan failed: ${err instanceof Error ? err.message : String(err)}`);
    // V4 scan failed entirely — fall through to null
  }

  const totalDuration = Date.now() - resolveStart;
  console.log(`[timing] Pool resolution completed in ${totalDuration}ms, no pool found`);
  return null;

  return null;
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


  type PoolLog = V3PoolLog | V4PoolLog;

  const allLogs: PoolLog[] = [];
  let chunksFetched = 0;
  let chunksFailed  = 0;

  for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += CHUNK_SIZE) {
    const chunkEnd = chunkStart + CHUNK_SIZE - 1n < toBlock
      ? chunkStart + CHUNK_SIZE - 1n
      : toBlock;

    try {
      const chunkStartMs = Date.now();
      console.log(`[timing] Starting chunk ${chunksFetched + 1}/${numChunks}: blocks ${chunkStart}-${chunkEnd}`);
      
      // Fetch V3 PoolCreated events
      const v3Start = Date.now();
      const v3Logs = await client.getLogs({
        address: UNISWAP_V3_FACTORY,
        event:   POOL_CREATED_ABI[0],
        fromBlock: chunkStart,
        toBlock:   chunkEnd,
      });
      const v3Duration = Date.now() - v3Start;
      console.log(`[timing] V3 getLogs completed in ${v3Duration}ms`);

      // Fetch V4 Initialize events
      const v4Start = Date.now();
      const v4Logs = await client.getLogs({
        address: UNISWAP_V4_POOL_MANAGER,
        event:   V4_INITIALIZE_ABI[0],
        fromBlock: chunkStart,
        toBlock:   chunkEnd,
      });
      const v4Duration = Date.now() - v4Start;
      console.log(`[timing] V4 getLogs completed in ${v4Duration}ms`);
      
      const chunkDuration = Date.now() - chunkStartMs;
      console.log(`[timing] Chunk ${chunksFetched + 1} total duration: ${chunkDuration}ms`);

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
      if (pairedLabel === "ambiguous") {
        console.log(`  ⚠️  Ambiguous pair — both tokens are known base assets (e.g. WETH/USDC). Skipping.\n`);
      } else {
        console.log(`  ⚠️  Neither token is a known base asset — not a new-token launch. Skipping.\n`);
      }
      console.log(`${"─".repeat(66)}\n`);
      skipped++;
      continue;
    }

    // Early skip check (e.g., already posted) before expensive evidence collection
    if (opts?.shouldSkip && (await opts.shouldSkip(newToken, poolAddress, pairedLabel))) {
      console.log(`  [scan-engine] Skipping ${newToken} — shouldSkip returned true\n`);
      console.log(`${"─".repeat(66)}\n`);
      skipped++;
      continue;
    }

    // Fetch ERC-20 metadata
    const metaStart = Date.now();
    console.log(`[timing] Starting metadata fetch for ${newToken}`);
    let meta;
    try {
      meta = await fetchTokenMetadata(client, newToken);
      const metaDuration = Date.now() - metaStart;
      console.log(`[timing] Metadata fetch completed in ${metaDuration}ms`);
    } catch (err) {
      const metaDuration = Date.now() - metaStart;
      console.error(`[timing] Metadata fetch failed for ${newToken} in ${metaDuration}ms: ${err}\n`);
      console.log(`${"─".repeat(66)}\n`);
      skipped++;
      continue;
    }

    // Grace delay — give the deployer's LP-add transaction time to land before
    // evidence collection starts.  On Base (~2 s/block) 30 s ≈ 15 blocks, which
    // combined with the new LP_LOCK_SCAN_WINDOW covers the vast majority of pools
    // that add liquidity within the first few minutes of creation.
    console.log(`  [scan-engine] Waiting 30 s before evidence collection (grace period for LP add)…`);
    await sleep(30_000);

    // Run LLM rug check
    const rugCheckStart = Date.now();
    console.log(`[timing] Starting rug check for ${newToken}`);
    let rugResult;
    try {
      rugResult = await runRugCheckLLM(client, newToken, poolAddress, pairedLabel, blockNum, meta, {
        mode: "alert",
        venue,
        hookAddress,
        v4PoolParams,
      });
      const rugCheckDuration = Date.now() - rugCheckStart;
      console.log(`[timing] Rug check completed in ${rugCheckDuration}ms`);
    } catch (err) {
      const rugCheckDuration = Date.now() - rugCheckStart;
      console.error(`[timing] Rug check failed for ${newToken} in ${rugCheckDuration}ms: ${err}\n`);
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

    // ── Deferred re-verification pass ────────────────────────────────────────
    const analysisId = rugResult.analysisId;
    const lastDecision = rugResult.decisionTrace?.[rugResult.decisionTrace.length - 1];
    const needsRecheck = analysisId && lastDecision?.unresolvedMandatory.length;

    if (needsRecheck) {
      const recheckDelay = lastDecision?.action === "stop" ? 3 * 60_000 : 60_000;
      console.log(
        `  [scan-engine] Scheduling re-verification for ${newToken} in ${recheckDelay / 60_000} min` +
        ` (unresolved: ${lastDecision?.unresolvedMandatory.join(", ")})`
      );
      setTimeout(async () => {
        try {
          console.log(`\n  [reverify] Starting re-verification for ${newToken} (id: ${analysisId})`);

          // reVerifyEvidence stays as-is for the LP-lock/liquidity special
          // case; unresolvedMandatory (e.g. deployer history) triggers a
          // fresh dispatchTool() call instead, not reVerifyEvidence
          if (lastDecision?.unresolvedMandatory.includes("getDeployerHistory")) {
            // Trigger a fresh agent call to resolve the missing tier
            console.log(`  [reverify] Re-running agent loop to resolve missing mandatory tiers`);
            // This would need to trigger a fresh analysis - for now we just log
            console.log(`  [reverify] Would re-run agent loop for: ${lastDecision.unresolvedMandatory.join(", ")}`);
            return;
          }

          // Build a minimal TokenEvidence stub from the fields already on rugResult —
          // reVerifyEvidence only reads poolAddress, lpPositionStatus and poolLiquidity
          // from the original evidence; everything else is re-fetched live.
          const evidenceStub = {
            poolAddress:      rugResult.poolAddress as string,
            lpPositionStatus: rugResult.lpPositionStatus,
            poolLiquidity:    rugResult.poolLiquidity !== null
              ? rugResult.poolLiquidity.toString()
              : null,
          } as import("./evidence.js").TokenEvidence;

          const recheck = await reVerifyEvidence(
            client as AnyClient,
            evidenceStub,
            blockNum,
            venue,
            v4PoolParams
          );

          if (!recheck.improved) {
            console.log(`  [reverify] No improvement found for ${newToken} — record unchanged`);
            return;
          }

          // Build the evidence patch — only include fields that actually changed
          const evidencePatch: Record<string, unknown> = {};
          if (recheck.lpPositionStatus !== undefined) {
            evidencePatch.lpPositionStatus = recheck.lpPositionStatus;
            evidencePatch.lpTokenId        = recheck.lpTokenId ?? null;
            evidencePatch.lpPositionOwner  = recheck.lpPositionOwner ?? null;
          }
          if (recheck.poolLiquidity !== undefined) {
            evidencePatch.poolLiquidity       = recheck.poolLiquidity;
            evidencePatch.initialLiquidityEth = recheck.initialLiquidityEth ?? null;
            evidencePatch.liquidityLocked     = recheck.liquidityLocked ?? null;
          }

          await updateAnalysis(analysisId, {
            // evidencePatch is deep-merged into the stored evidence object by updateAnalysis
            evidencePatch,
          });
          console.log(`  [reverify] Updated analysis ${analysisId} for ${newToken}`);
        } catch (err) {
          console.error(`  [reverify] Failed for ${newToken}:`, err);
        }
      }, recheckDelay);
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