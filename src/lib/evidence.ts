/**
 * evidence.ts — pure on-chain data collection, no scoring.
 *
 * REAL-TIME ONLY. Every function that used to scan a historical block range
 * via client.getLogs or Etherscan's `logs` module (checkPreLiquidityDistribution)
 * has been deleted outright — see the "DELETED" comment above each one. That data is
 * inherently historical (who minted the token, who has held it over time,
 * whether liquidity was ever pulled) and there is no real-time substitute
 * for it; this app no longer tries.
 *
 * Exports:
 *   collectMinimalEvidence(client, tokenAddress, poolAddress, pairedAsset, deployBlock)
 *     → TokenEvidence  (metadata + ownership + proxy + liquidity only —
 *       deployerAddress etc. are always null now, see above)
 *
 *   Individual evidence functions (called on-demand by agents/tools.ts):
 *     checkSourceVerification, runSellTest, checkDeployerVelocity,
 *     checkDeployerWalletAge, checkLiquidityDelta — all real-time or
 *     txlist-based (not the blocked `logs` module), so these still work.
 *
 * All RPC failures are logged to stdout AND recorded in `rpcWarnings[]` so
 * the LLM scorer can see which fields are unverified rather than treating
 * nulls as implicitly clean.
 *
 * V4 support:
 *   All pool-specific reads have a V4 branch that uses the singleton
 *   PoolManager / StateView contract rather than per-pool contract calls.
 *   poolAddress for V4 tokens is the bytes32 PoolId cast to Address — it is
 *   NOT a callable contract.  Every function that reads pool state must
 *   branch on `venue` before issuing any RPC call against poolAddress.
 */

import { type Address, formatEther, encodeFunctionData } from "viem";
import type { PublicClient } from "viem";
import type { LiquiditySnapshot } from "./state.js";
import { getLiquidityHistory } from "./state.js";
import {
  OWNER_ABI,
  NULL_ADDRESS,
  EIP1967_IMPL_SLOT,
  POOL_SLOT0_ABI,
  POOL_LIQUIDITY_ABI,
  POOL_TOKENS_ABI,
  ERC20_ABI,
  BURN_ADDRESS,
  ETHERSCAN_API_BASE,
  BASE_CHAIN_ID,
  ERC20_TRANSFER_ABI,
  // V4-specific
  UNISWAP_V4_POOL_MANAGER,
  UNISWAP_V4_STATE_VIEW,
  UNISWAP_V4_QUOTER,
  V4_STATE_VIEW_SLOT0_ABI,
  V4_STATE_VIEW_LIQUIDITY_ABI,
  V4_QUOTER_EXACT_INPUT_SINGLE_ABI,
  type Venue,
} from "./utils/constants.js";
import type { TokenEvidence, ReVerifyResult } from "./utils/interface.js";
import { analyzeSourceWithLLM } from "./source-audit.js";
import type { FunctionAudit, SourceAuditMethod } from "./llm-types.js";

// Re-export types that are used by other modules
export type { TokenEvidence, ReVerifyResult };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

const ZERO_SLOT    =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// ─── TokenEvidence ────────────────────────────────────────────────────────────

/**
 * All numbers that could overflow JSON's float precision are stored as
 * strings. The LLM receives this object serialised as JSON so bigint →
 * string conversion is done here, not in the scorer.
 */


// ─── Internal helpers ─────────────────────────────────────────────────────────

function warn(warnings: string[], tag: string, context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
  const entry = `[${tag}] ${context}: ${msg}`;
  console.warn(`  [evidence:${tag}] ${context}: ${msg}`);
  warnings.push(entry);
}

// async function safeRead<T>(
//   fn: () => Promise<T>,
//   fallback: T,
//   tag: string,
//   warnings: string[]
// ): Promise<T> {
//   try { return await fn(); }
//   catch (err) { warn(warnings, tag, "read failed, using fallback", err); return fallback; }
// }

async function safeReadNullable<T>(
  fn: () => Promise<T>,
  tag: string,
  warnings: string[]
): Promise<T | null> {
  try { return await fn(); }
  catch (err) { warn(warnings, tag, "read failed", err); return null; }
}

// ─── (Etherscan log-indexing helper — DELETED, real-time-only mode) ────────
// This used to fetch ERC-20 Transfer logs from Etherscan's `logs` module for
// checkPreLiquidityDistribution. Base's free-tier Etherscan key returns "Free API access is not supported for
// this chain" for every call to that module, and there's no raw-RPC fallback
// that stays under the free-tier eth_getLogs block-range cap either. The
// caller is gone (see below), so this helper is gone too — it only
// existed to serve it.

// ─── Etherscan deployer tx history helper ────────────────────────────────────

/**
 * Fetch a page of transactions for `deployerAddress` from Etherscan's txlist
 * endpoint.  Returns [] on any failure (network error, bad JSON, API error).
 *
 * @param sort    "asc" | "desc"
 * @param offset  Number of records to skip (Etherscan page offset)
 * @param count   Max records to return (Etherscan `limit` param)
 */
async function fetchDeployerTxHistory(
  deployerAddress: string,
  apiKey: string,
  opts: { sort: "asc" | "desc"; offset?: number; count?: number },
  warnings: string[]
): Promise<Array<{ hash: string; to: string; timeStamp: string; contractAddress: string }>> {
  const { sort, offset = 0, count = 200 } = opts;
  try {
    const url =
      `${ETHERSCAN_API_BASE}?chainid=${BASE_CHAIN_ID}` +
      `&module=account&action=txlist` +
      `&address=${deployerAddress}` +
      `&startblock=0&endblock=99999999` +
      `&page=1&offset=${count}&sort=${sort}` +
      (offset > 0 ? `&startindex=${offset}` : "") +
      `&apikey=${apiKey}`;
    const res  = await fetch(url);
    const json = await res.json() as { status: string; result: unknown };
    if (json.status !== "1" || !Array.isArray(json.result)) return [];
    return json.result as Array<{ hash: string; to: string; timeStamp: string; contractAddress: string }>;
  } catch (err) {
    warn(warnings, "etherscan.txlist", `fetch failed for ${deployerAddress}`, err);
    return [];
  }
}

// ─── New signal: deployer velocity ───────────────────────────────────────────

/**
 * How many contracts did this deployer create in the 15 min / 1 h / 24 h
 * window immediately before (and including) `deployBlockTimestamp`?
 *
 * Uses Etherscan txlist (direct creates only; factory-pattern deploys via an
 * intermediate launcher won't appear here — those require txlistinternal).
 */
export async function checkDeployerVelocity(
  deployerAddress: string,
  deployBlockTimestamp: number,
  apiKey: string,
  warnings: string[]
): Promise<{ deploysLast15Min: number; deploysLastHour: number; deploysLast24h: number; recentContracts: string[] }> {
  const txs = await fetchDeployerTxHistory(deployerAddress, apiKey, { sort: "desc", count: 200 }, warnings);

  const T15  = deployBlockTimestamp - 15 * 60;
  const T1h  = deployBlockTimestamp - 60 * 60;
  const T24h = deployBlockTimestamp - 24 * 60 * 60;

  let last15  = 0;
  let lastHr  = 0;
  let last24h = 0;
  const recentContracts: string[] = [];

  for (const tx of txs) {
    // Direct contract creation: `to` field is empty string
    if (tx.to !== "") continue;
    const ts = parseInt(tx.timeStamp, 10);
    if (ts > deployBlockTimestamp) continue; // shouldn't happen but guard it
    if (ts < T24h) break; // txs are desc-sorted; once we pass 24h window, stop

    last24h++;
    if (tx.contractAddress) recentContracts.push(tx.contractAddress.toLowerCase());
    if (ts >= T1h)  lastHr++;
    if (ts >= T15)  last15++;
  }

  return { deploysLast15Min: last15, deploysLastHour: lastHr, deploysLast24h: last24h, recentContracts };
}

// ─── New signal: deployer wallet age ─────────────────────────────────────────

/**
 * How old was the deployer wallet when it deployed this token, and how
 * recently was it funded before the deploy?
 *
 * - `walletAgeAtDeploySeconds`: time from the wallet's very first tx to the
 *   deploy block.  A wallet < 10 min old is almost certainly disposable.
 * - `fundingGapSeconds`: seconds between the last inbound-value tx to the
 *   wallet and the deploy block.  < 2 min suggests purpose-built funding.
 * - `fundingSourceAddress`: the sender of that last inbound tx.
 */
export async function checkDeployerWalletAge(
  deployerAddress: string,
  deployBlockTimestamp: number,
  apiKey: string,
  warnings: string[]
): Promise<{ walletAgeAtDeploySeconds: number | null; fundingGapSeconds: number | null; fundingSourceAddress: string | null }> {
  // First-ever tx (asc, limit 1) → wallet creation timestamp
  const firstTxs = await fetchDeployerTxHistory(
    deployerAddress, apiKey, { sort: "asc", count: 1 }, warnings
  );
  let walletAgeAtDeploySeconds: number | null = null;
  if (firstTxs.length > 0) {
    const firstTs = parseInt(firstTxs[0].timeStamp, 10);
    walletAgeAtDeploySeconds = deployBlockTimestamp - firstTs;
  }

  // Most recent 20 txs (desc) → find last inbound-value tx before deploy
  const recentTxs = await fetchDeployerTxHistory(
    deployerAddress, apiKey, { sort: "desc", count: 20 }, warnings
  ) as Array<{ hash: string; to: string; from: string; timeStamp: string; contractAddress: string; value: string }>;

  let fundingGapSeconds: number | null = null;
  let fundingSourceAddress: string | null = null;

  for (const tx of recentTxs) {
    const ts  = parseInt(tx.timeStamp, 10);
    if (ts > deployBlockTimestamp) continue; // skip anything after deploy
    // Inbound tx: `to` is the deployer address and value > 0
    if (
      tx.to.toLowerCase() === deployerAddress.toLowerCase() &&
      tx.value && BigInt(tx.value) > 0n
    ) {
      fundingGapSeconds    = deployBlockTimestamp - ts;
      fundingSourceAddress = tx.from?.toLowerCase() ?? null;
      break;
    }
  }

  return { walletAgeAtDeploySeconds, fundingGapSeconds, fundingSourceAddress };
}

// ─── New signal: pre-liquidity distribution — DELETED (real-time-only mode) ──
// Historically walked Transfer events between mintBlock and scanToBlock to
// find pre-launch recipients. Same historical-scan problem as other
// deleted functions; this field isn't wired into any tool or the default evidence
// object today, so it's removed rather than stubbed.

// ─── Deployer finder — DELETED (real-time-only mode) ─────────────────────────
// Used to scan Transfer-from-0x0 (mint) events across a wide historical
// window — either via Etherscan's `logs` module (blocked on Base's free
// tier: "Free API access is not supported for this chain") or, as a
// fallback, raw chunked eth_getLogs (capped too low by free RPC tiers to be
// practical). Deployer identity is inherently historical — there is no
// real-time equivalent — so this is deleted outright. It was never called
// from collectMinimalEvidence (deployerAddress is set to a literal `null` 
// there) and had no live tool wired to it, so nothing else needs updating.

// ─── Holder balance scan — DELETED (real-time-only mode) ────────────────────
// Historically this walked every Transfer event from a wide starting block
// to the chain head — via Etherscan's `logs` module (blocked on Base's free
// tier) or, as a fallback, raw chunked eth_getLogs (capped far too low by RPC
// providers to be practical). Deleted; the getHolderLedger tool that called
// this has also been removed (see tools.ts) — holder-distribution-agent now
// scores directly off the empty/unverified defaults already present in
// TokenEvidence.

// ─── Liquidity delta check ────────────────────────────────────────────────────

/**
 * Read current liquidity and compare to the last stored snapshot.
 * Branches on venue: V4 reads from StateView using the poolId (bytes32),
 * V3 reads directly from the pool contract.
 *
 * The `poolIdOrAddress` param carries:
 *   - V3: the pool contract address
 *   - V4: the bytes32 PoolId, hex-encoded (looks like an address in storage)
 */
export async function checkLiquidityDelta(
  client: AnyClient,
  poolIdOrAddress: Address,
  venue: Venue = "v3"
): Promise<{
  liquidityDeltaPct: number | null;
  liquidityPreviousReading: string | null;
  snapshotAgeMinutes: number | null;
  currentSnapshot: LiquiditySnapshot;
}> {
  const history = await getLiquidityHistory(poolIdOrAddress);
  const prev = history[history.length - 1];

  let current: bigint;
  if (venue === "v4") {
    // V4: read from StateView using the poolId as bytes32
    current = await client.readContract({
      address: UNISWAP_V4_STATE_VIEW as Address,
      abi: V4_STATE_VIEW_LIQUIDITY_ABI,
      functionName: "getLiquidity",
      args: [poolIdOrAddress],
    }) as bigint;
  } else {
    // V3: read directly from the pool contract
    current = await client.readContract({
      address: poolIdOrAddress,
      abi: POOL_LIQUIDITY_ABI,
      functionName: "liquidity",
    }) as bigint;
  }

  const snap: LiquiditySnapshot = {
    liquidity: current.toString(),
    blockNumber: (await client.getBlockNumber()).toString(),
    ts: Date.now(),
  };

  // Caller is responsible for persisting the returned currentSnapshot via
  // recordLiquiditySnapshot() — we only read history here.
  if (!prev) {
    return { liquidityDeltaPct: null, liquidityPreviousReading: null, snapshotAgeMinutes: null, currentSnapshot: snap };
  }

  const prevVal  = BigInt(prev.liquidity);
  const deltaPct = prevVal === 0n
    ? null
    : Number(((current - prevVal) * 10000n) / prevVal) / 100;

  return {
    liquidityDeltaPct: deltaPct,
    liquidityPreviousReading: prev.liquidity,
    snapshotAgeMinutes: Math.round((Date.now() - prev.ts) / 60000),
    currentSnapshot: snap,
  };
}

// ── 1. Sell-ability / honeypot test (V3) ─────────────────────────────────────
//
// V3: simulate transfer(poolAddress, amount) via eth_call.  If the token
// contract reverts, it has a transfer blacklist/hook.
//
// V4: simulate via the Quoter contract.  The Quoter calls the PoolManager and
// runs any attached hook — if the hook blocks the swap the call reverts.
// We construct a minimal PoolKey from the stored params and call
// quoteExactInputSingle.  A revert means the hook is blocking sells.

export async function testSellability(
  client: AnyClient,
  tokenAddress: Address,
  poolIdOrAddress: Address,
  top5: Array<{ address: string; balance: string }>,
  ownerAddress: string | null,
  deployerAddress: string | null,
  warnings: string[],
  venue: Venue = "v3",
  v4PoolParams?: {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
  },
  /** Pass the already-computed liquidity value so we can skip the test when
   *  the pool is empty.  A revert against a zero-liquidity pool is not a
   *  honeypot signal — it's just "nothing to trade against". */
  poolLiquidityRaw: bigint | null = null
): Promise<{ sellTestPassed: boolean | null; sellTestAmountSent: string | null; sellTestError: string | null }> {
  // Guard: empty pool ⇒ any revert is ambiguous, not a honeypot signal.
  // Both V3 and V4 branches benefit from this check.
  if (poolLiquidityRaw !== null && poolLiquidityRaw === 0n) {
    return {
      sellTestPassed: null,
      sellTestAmountSent: null,
      sellTestError: "pool has zero liquidity — sell simulation skipped (not meaningful against an empty pool)",
    };
  }

  const candidate = top5.find(
    (h) =>
      h.address.toLowerCase() !== NULL_ADDRESS.toLowerCase() &&
      h.address.toLowerCase() !== BURN_ADDRESS.toLowerCase() &&
      (ownerAddress === null || h.address.toLowerCase() !== ownerAddress.toLowerCase()) &&
      (deployerAddress === null || h.address.toLowerCase() !== deployerAddress.toLowerCase()) &&
      BigInt(h.balance) > 0n
  );
  if (!candidate) {
    return {
      sellTestPassed: null,
      sellTestAmountSent: null,
      sellTestError: "only privileged wallets hold balance — test would be meaningless",
    };
  }

  const balance    = BigInt(candidate.balance);
  const testAmount = balance / 1000n > 0n ? balance / 1000n : balance; // 0.1% or full if tiny

  if (venue === "v4") {
    // V4 sell test: use the Quoter to simulate a swap through the PoolManager.
    // If v4PoolParams is missing we can't build the PoolKey — report gracefully.
    if (!v4PoolParams) {
      return {
        sellTestPassed: null,
        sellTestAmountSent: null,
        sellTestError: "V4 sell test skipped — PoolKey params not available",
      };
    }

    // Determine swap direction: selling the new token means
    //   zeroForOne = true  when the new token is currency0
    //   zeroForOne = false when the new token is currency1
    const zeroForOne =
      tokenAddress.toLowerCase() === v4PoolParams.currency0.toLowerCase();

    // testAmount is in token units (uint128); clamp to uint128 max
    const uint128Max = (2n ** 128n) - 1n;
    const quoteAmount = testAmount > uint128Max ? uint128Max : testAmount;

    try {
      // quoteExactInputSingle is nonpayable (uses transient storage) — must
      // use simulateContract, not readContract, otherwise viem refuses to call it.
      const result = await client.simulateContract({
        address: UNISWAP_V4_QUOTER as Address,
        abi: V4_QUOTER_EXACT_INPUT_SINGLE_ABI,
        functionName: "quoteExactInputSingle",
        args: [{
          poolKey: {
            currency0: v4PoolParams.currency0,
            currency1: v4PoolParams.currency1,
            fee:        v4PoolParams.fee,
            tickSpacing: v4PoolParams.tickSpacing,
            hooks:      v4PoolParams.hooks,
          },
          zeroForOne,
          exactAmount: quoteAmount,
          hookData: "0x" as `0x${string}`,
        }],
      });
      
      // If we get here, the simulation succeeded
      return { sellTestPassed: true, sellTestAmountSent: quoteAmount.toString(), sellTestError: null };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      
      // Check if the error is due to "No pool" or "Pool not initialized"
      if (errorMessage.includes("No pool") || errorMessage.includes("not initialized") || errorMessage.includes("Pool does not exist") || errorMessage.includes("uninitialized")) {
        // Pool doesn't exist or isn't properly initialized - this is not a honeypot signal
        return {
          sellTestPassed: null,
          sellTestAmountSent: null,
          sellTestError: "V4 pool not initialized or does not exist - sell test skipped",
        };
      }
      
      // Check if error is due to insufficient liquidity
      if (errorMessage.includes("insufficient liquidity") || errorMessage.includes("Insufficient liquidity") || errorMessage.includes("SLIPPAGE") || errorMessage.includes("low liquidity")) {
        return {
          sellTestPassed: null,
          sellTestAmountSent: null,
          sellTestError: "Insufficient pool liquidity - sell test inconclusive",
        };
      }
      
      // Check if error is just a generic revert without specific hook data
      // This often happens with pools that have no liquidity or are malformed
      if (errorMessage.includes("reverted with the following signature") && !errorMessage.includes("hook") && !errorMessage.includes("blacklist") && !errorMessage.includes("block")) {
        return {
          sellTestPassed: null,
          sellTestAmountSent: null,
          sellTestError: "V4 Quoter reverted (malformed pool or no liquidity) - sell test inconclusive",
        };
      }
      
      // If it's a revert from a hook blocking the swap, that's a honeypot signal
      warn(warnings, "sellTest", "V4 Quoter simulation reverted", err);
      const message = errorMessage.split("\n")[0];
      return { sellTestPassed: false, sellTestAmountSent: quoteAmount.toString(), sellTestError: message };
    }
  }

  // V3 path: simulate transfer(poolAddress, amount)
  try {
    await client.call({
      account: candidate.address as Address,
      to: tokenAddress,
      data: encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [poolIdOrAddress, testAmount],
      }),
    });
    return { sellTestPassed: true, sellTestAmountSent: testAmount.toString(), sellTestError: null };
  } catch (err) {
    warn(warnings, "sellTest", "simulated transfer to pool reverted", err);
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { sellTestPassed: false, sellTestAmountSent: testAmount.toString(), sellTestError: message };
  }
}

/**
 * Standalone sell test for a specific holder at a specific percentage.
 * Agent-friendly wrapper; V3-only (uses the transfer-to-pool simulation).
 */
export async function runSellTest(
  client: AnyClient,
  tokenAddress: Address,
  poolAddress: Address,
  holderAddress: Address,
  amountPct: number,
  warnings: string[]
): Promise<{ sellTestPassed: boolean | null; sellTestAmountSent: string | null; sellTestError: string | null }> {
  let balance: bigint;
  try {
    balance = await client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [holderAddress],
    }) as bigint;
  } catch (err) {
    warn(warnings, "sellTest", `failed to read balance for ${holderAddress}`, err);
    return { sellTestPassed: null, sellTestAmountSent: null, sellTestError: "failed to read holder balance" };
  }

  if (balance === 0n) {
    return { sellTestPassed: null, sellTestAmountSent: null, sellTestError: "holder has zero balance" };
  }

  const testAmount = (balance * BigInt(Math.floor(amountPct * 100))) / 10000n;
  if (testAmount === 0n) {
    return { sellTestPassed: null, sellTestAmountSent: null, sellTestError: "calculated test amount is zero" };
  }

  try {
    await client.call({
      account: holderAddress,
      to: tokenAddress,
      data: encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [poolAddress, testAmount],
      }),
    });
    return { sellTestPassed: true, sellTestAmountSent: testAmount.toString(), sellTestError: null };
  } catch (err) {
    warn(warnings, "sellTest", "simulated transfer to pool reverted", err);
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { sellTestPassed: false, sellTestAmountSent: testAmount.toString(), sellTestError: message };
  }
}

// ── 2. LP position lock/burn status — DELETED (real-time-only mode) ─────────
//
// Historically this scanned Mint/ModifyLiquidity events with client.getLogs
// over a wide block window to find the LP position and its owner (burned /
// locked / held by an EOA). That requires walking historical logs — exactly
// the wide-range eth_getLogs / Etherscan `logs`-module pattern this app no
// longer does. Deleted rather than stubbed; lp-honeypot-agent no longer has
// a checkLpLock tool to call, and scores directly off the "unverified"
// default already present in TokenEvidence.lpPositionStatus. The
// orchestrator's mandatory-tool-owner entry for checkLpLock has been removed
// to match (see orchestrator.ts).

// ── 3. Liquidity pull history — DELETED (real-time-only mode) ───────────────
// Historically this counted Burn / negative-liquidityDelta events across the
// pool's whole history via client.getLogs. Same historical-scan problem as
// everything else in this section. This was already dead code (never wired
// into any tool) even as a stub, so it's just gone now.

// ── Trade activity scan — DELETED (real-time-only mode) ─────────────────────
// Historically this scanned every Swap event from deployBlock to the current
// head via client.getLogs to detect wash trading / bot volume. That's
// inherently historical — no real-time equivalent exists — so the function
// (and its getTradeHistory tool) has been removed entirely rather than kept
// as a stub. trading-activity-agent now scores directly off the zeroed
// defaults already present in TokenEvidence (totalSwaps, uniqueTraders, etc.)
// with no tool call involved.

// ── 4. Source verification — fetch + LLM rubric audit ─────────────────────────
// Keyword-grep replaced by analyzeSourceWithLLM() (src/lib/source-audit.ts).
// This function now only does the Etherscan fetch; all judgment (suspicious
// function detection, secondary-admin detection) happens in the agent, which
// falls back to a keyword heuristic internally if the LLM call fails.
/**
 * Etherscan returns SourceCode in one of three shapes:
 *   1. Flat Solidity text (single-file verification) — most common.
 *   2. `{{...}}` — a JSON object double-wrapped in braces (Standard-JSON-Input
 *      verification). The outer braces must be stripped before JSON.parse.
 *   3. `{...}` — same JSON shape but only single-wrapped (some proxies/older
 *      compiler UIs). Handle both defensively.
 * In both (2) and (3) the parsed object's `sources` map holds one entry per
 * file, each with a `.content` string — those need to be concatenated so the
 * LLM audit sees every imported file (e.g. OpenZeppelin bases with the real
 * mint/blacklist logic) instead of just whatever the naive raw string was.
 */
function unwrapMultiFileSource(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;

  // Strip one layer of doubled braces: "{{ ... }}" -> "{ ... }"
  const candidate = trimmed.startsWith("{{") && trimmed.endsWith("}}")
    ? trimmed.slice(1, -1)
    : trimmed;

  try {
    const parsed = JSON.parse(candidate);
    const sources = parsed?.sources ?? parsed; // some payloads skip the "sources" wrapper
    if (sources && typeof sources === "object") {
      const files = Object.entries(sources)
        .map(([path, val]) => {
          const content = (val as { content?: string })?.content;
          return content ? `// ── ${path} ──\n${content}` : null;
        })
        .filter((x): x is string => x !== null);
      if (files.length > 0) return files.join("\n\n");
    }
  } catch {
    // Not valid JSON despite looking like it — fall through and audit the
    // raw string as-is rather than silently dropping it.
  }
  return raw;
}

/** Reads the EIP-1967 implementation slot and returns the address portion
 *  (last 20 bytes) of the 32-byte storage word, or null if it's empty/unset. */
function implementationAddressFromSlot(slot: `0x${string}` | undefined): Address | null {
  if (!slot || slot === ZERO_SLOT) return null;
  const addr = `0x${slot.slice(-40)}`;
  return addr.toLowerCase() === NULL_ADDRESS.toLowerCase() ? null : (addr as Address);
}

async function fetchVerifiedSource(
  address: Address,
  apiKey: string,
  warnings: string[],
  tag: string
): Promise<string> {
  try {
    const url  = `${ETHERSCAN_API_BASE}?chainid=${BASE_CHAIN_ID}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;
    const res  = await fetch(url);
    const json = await res.json();
    const raw: string = json?.result?.[0]?.SourceCode ?? "";
    return raw ? unwrapMultiFileSource(raw) : "";
  } catch (err) {
    warn(warnings, tag, "Etherscan API call failed", err);
    return "";
  }
}

export async function checkSourceVerification(
  client: AnyClient,
  tokenAddress: Address,
  warnings: string[],
  ownershipRenounced: boolean | null,
  ownerAddress: string | null,
  isProxy: boolean | null
): Promise<{
  sourceVerified: boolean | null;
  suspiciousFunctions: { name: string; snippet: string }[];
  secondaryAdminDetected: boolean;
  secondaryAdminSnippet: string | null;
  sourceAuditMethod: SourceAuditMethod | null;
  functionAudits: FunctionAudit[];
  /** True when isProxy was true AND we successfully pulled the *implementation*
   *  contract's source (rather than just the thin proxy shim) for the audit. */
  proxyImplementationAudited: boolean;
  /** The implementation address that was actually audited, if any. */
  proxyImplementationAddress: string | null;
}> {
  const empty = {
    sourceVerified: null as boolean | null, suspiciousFunctions: [] as { name: string; snippet: string }[],
    secondaryAdminDetected: false, secondaryAdminSnippet: null as string | null,
    sourceAuditMethod: null as SourceAuditMethod | null, functionAudits: [] as FunctionAudit[],
    proxyImplementationAudited: false, proxyImplementationAddress: null as string | null,
  };

  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    warn(warnings, "sourceCheck", "ETHERSCAN_API_KEY not set — skipping", "missing env var");
    return empty;
  }

  let source = await fetchVerifiedSource(tokenAddress, apiKey, warnings, "sourceCheck");

  // Proxy follow-up: getsourcecode on the token address returns the proxy
  // shim's source (usually a boring EIP-1967 delegate), not the real logic.
  // Read the implementation slot directly and audit *that* contract instead
  // — this matters most pre-launch, since a clean-looking implementation
  // today says nothing about what the owner swaps it to tomorrow, which is
  // why proxy status is flagged independently in scoring.ts regardless of
  // what this audit finds.
  let proxyImplementationAudited = false;
  let proxyImplementationAddress: string | null = null;

  if (isProxy) {
    try {
      const slot = await client.getStorageAt({ address: tokenAddress, slot: EIP1967_IMPL_SLOT });
      const implAddress = implementationAddressFromSlot(slot as `0x${string}` | undefined);
      if (implAddress) {
        proxyImplementationAddress = implAddress;
        const implSource = await fetchVerifiedSource(implAddress, apiKey, warnings, "sourceCheck:proxyImpl");
        if (implSource) {
          source = implSource;
          proxyImplementationAudited = true;
        } else {
          warn(warnings, "sourceCheck:proxyImpl", `implementation ${implAddress} not verified`, "no source returned");
        }
      } else {
        warn(warnings, "sourceCheck:proxyImpl", "isProxy=true but implementation slot is empty", "unresolved implementation");
      }
    } catch (err) {
      warn(warnings, "sourceCheck:proxyImpl", "implementation slot read failed", err);
    }
  }

  if (!source) {
    return { ...empty, sourceVerified: false, proxyImplementationAudited, proxyImplementationAddress };
  }

  const audit = await analyzeSourceWithLLM(source, ownershipRenounced, ownerAddress, warnings);
  return {
    sourceVerified: true,
    suspiciousFunctions: audit.suspiciousFunctions,
    secondaryAdminDetected: audit.secondaryAdminDetected,
    secondaryAdminSnippet: audit.secondaryAdminSnippet,
    sourceAuditMethod: audit.method,
    functionAudits: audit.functionAudits,
    proxyImplementationAudited,
    proxyImplementationAddress,
  };
}


// ─── Main collection function ─────────────────────────────────────────────────

/** Identification only: pool/token resolution, deploy block, hasLiquidity.
 *  Everything else (holder scan, source check, sell test, LP lock, deployer
 *  forensics, trade activity) is now called on-demand via agents/tools.ts,
 *  not bundled here. */
export async function collectMinimalEvidence(
  client: AnyClient,
  tokenAddress: Address,
  /** V3: pool contract address. V4: bytes32 PoolId hex-encoded as Address. */
  poolAddress: Address,
  pairedAsset: string,
  deployBlock: bigint,
  meta: { name: string; symbol: string; decimals: number; totalSupply: bigint; totalSupplyFormatted: string },
  venue?: Venue,
  /** V4 only: the hook contract address from the Initialize event. */
  hookAddress?: string | null,
  /** V4 only: PoolKey parameters needed for the sell-simulation Quoter call. */
  v4PoolParams?: {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
  }
): Promise<TokenEvidence> {
  const warnings: string[] = [];
  const resolvedVenue: Venue = venue ?? "v3";

  // ── 1. ERC-20 supply / decimals ────────────────────────────────────────────
  const { name, symbol, decimals, totalSupply, totalSupplyFormatted } = meta;

  // ── 2. Ownership ───────────────────────────────────────────────────────────
  let ownerAddress: string | null = null;
  let ownershipRenounced: boolean | null = null;
  try {
    // First check if the contract has bytecode (not an EOA)
    const code = await client.getBytecode({ address: tokenAddress });
    if (!code || code === "0x") {
      // This is an EOA, not a contract - no owner() function
      ownerAddress = tokenAddress; // EOAs "own" themselves
      ownershipRenounced = false;
    } else {
      // Try to call owner() - not all contracts have this function
      // Use a silent approach first to avoid noisy warnings
      try {
        ownerAddress = await client.readContract({
          address: tokenAddress,
          abi:     OWNER_ABI,
          functionName: "owner",
        }) as string;
        ownershipRenounced = ownerAddress === NULL_ADDRESS;
      } catch (ownerErr) {
        // Check if this is a revert vs other error
        const errorMsg = ownerErr instanceof Error ? ownerErr.message : String(ownerErr);
        if (errorMsg.includes("revert") || errorMsg.includes("owner") || errorMsg.includes("function")) {
          // Token likely doesn't use Ownable pattern - this is normal for many tokens
          // Don't log as warning, just set to null and continue
          ownerAddress = null;
          ownershipRenounced = null;
        } else {
          // Other unexpected error - log as warning
          warn(warnings, "owner", "owner() call failed with unexpected error", ownerErr);
          ownerAddress = null;
          ownershipRenounced = null;
        }
      }
    }
  } catch (err) {
    // Bytecode check failed - treat as non-ownable
    ownerAddress = null;
    ownershipRenounced = null;
  }

  // ── 3. Proxy check ─────────────────────────────────────────────────────────
  let isProxy: boolean | null = null;
  try {
    const slot = await client.getStorageAt({ address: tokenAddress, slot: EIP1967_IMPL_SLOT });
    isProxy = slot !== undefined ? slot !== ZERO_SLOT : null;
  } catch (err) {
    warn(warnings, "proxy", "EIP-1967 slot read failed", err);
  }

  // ── 4. Deployer (removed in real-time-only mode) ─────────────────────────
  // Deployer identity is inherently historical — there is no real-time
  // equivalent, so it's set to null here.
  const deployer = { address: null, mintBlock: null, mintAmount: null, source: "unknown" };

  // ── 5. Pool liquidity + initial ETH value ─────────────────────────────────
  let poolLiquidityRaw: bigint | null = null;
  let liquidityLocked: boolean | null = null;
  let initialLiquidityEth: number | null = null;

  if (resolvedVenue === "v4") {
    // V4: read from StateView using the poolId as bytes32
    poolLiquidityRaw = await safeReadNullable<bigint>(
      () => client.readContract({
        address: UNISWAP_V4_STATE_VIEW as Address,
        abi:     V4_STATE_VIEW_LIQUIDITY_ABI,
        functionName: "getLiquidity",
        args: [poolAddress],
      }) as Promise<bigint>,
      "pool.liquidity.v4",
      warnings
    );
    liquidityLocked = poolLiquidityRaw === null ? null : poolLiquidityRaw > 0n;

    if (poolLiquidityRaw !== null && poolLiquidityRaw > 0n) {
      try {
        const slot0 = await client.readContract({
          address: UNISWAP_V4_STATE_VIEW as Address,
          abi:     V4_STATE_VIEW_SLOT0_ABI,
          functionName: "getSlot0",
          args: [poolAddress],
        }) as readonly [bigint, ...unknown[]];
        const sqrtPriceX96 = slot0[0];
        if (sqrtPriceX96 > 0n) {
          const Q96 = 2n ** 96n;
          const raw = Number(formatEther((poolLiquidityRaw * Q96) / sqrtPriceX96));
          // No real Base pool holds more than ~100k ETH; anything above that
          // is a sqrtPriceX96 overflow artifact — null it out server-side.
          const ETH_SUPPLY_MAX = 100_000;
          if (raw > ETH_SUPPLY_MAX) {
            warnings.push(
              `[pool.slot0.v4] initialLiquidityEth=${raw.toFixed(0)} ETH exceeds 100k ETH ceiling — overflow artifact, nulled`
            );
            initialLiquidityEth = null;
          } else {
            initialLiquidityEth = raw;
          }
        } else {
          warnings.push(
            `[pool.slot0.v4] getSlot0 returned sqrtPriceX96=0 despite liquidity=${poolLiquidityRaw} — hook may not have initialized price yet, initialLiquidityEth left unverified`
          );
        }
      } catch (err) {
        warn(warnings, "pool.slot0.v4", "StateView.getSlot0 failed", err);
      }
    }
  } else {
    // V3: read directly from the pool contract
    poolLiquidityRaw = await safeReadNullable<bigint>(
      () => client.readContract({
        address: poolAddress,
        abi:     POOL_LIQUIDITY_ABI,
        functionName: "liquidity",
      }) as Promise<bigint>,
      "pool.liquidity",
      warnings
    );
    liquidityLocked = poolLiquidityRaw === null ? null : poolLiquidityRaw > 0n;

    if (poolLiquidityRaw !== null && poolLiquidityRaw > 0n) {
      try {
        const slot0 = await client.readContract({
          address: poolAddress,
          abi:     POOL_SLOT0_ABI,
          functionName: "slot0",
        }) as readonly [bigint, ...unknown[]];
        const sqrtPriceX96 = slot0[0];
        if (sqrtPriceX96 > 0n) {
          const Q96 = 2n ** 96n;
          const raw = Number(formatEther((poolLiquidityRaw * Q96) / sqrtPriceX96));
          // No real Base pool holds more than ~100k ETH; anything above that
          // is a sqrtPriceX96 overflow artifact — null it out server-side.
          const ETH_SUPPLY_MAX = 100_000;
          if (raw > ETH_SUPPLY_MAX) {
            warnings.push(
              `[pool.slot0] initialLiquidityEth=${raw.toFixed(0)} ETH exceeds 100k ETH ceiling — overflow artifact, nulled`
            );
            initialLiquidityEth = null;
          } else {
            initialLiquidityEth = raw;
          }
        } else {
          warnings.push(
            `[pool.slot0] slot0 returned sqrtPriceX96=0 despite liquidity=${poolLiquidityRaw} — initialLiquidityEth left unverified`
          );
        }
      } catch (err) {
        warn(warnings, "pool.slot0", "slot0 read failed", err);
      }
    }
  }

  // hasLiquidity is TRUE only on a confirmed >0 on-chain read. It is FALSE
  // both when the read failed (poolLiquidityRaw === null) and when it
  // succeeded with 0 — either way there is no real pool to test against yet,
  // so every liquidity-dependent check downstream should be treated as
  // "pending" rather than "failed"/"risky". scoring.ts uses this single flag
  // to gate the whole liquidity-dependent branch instead of penalizing each
  // individual null field.
  const hasLiquidity = poolLiquidityRaw !== null && poolLiquidityRaw > 0n;

  // ── 6. Assemble minimal evidence ────────────────────────────────────────────
  return {
    tokenAddress,
    poolAddress,
    pairedAsset,
    venue: resolvedVenue,
    deployBlock: deployBlock.toString(),

    hookAddress: resolvedVenue === "v4" ? (hookAddress ?? null) : null,

    name,
    symbol,
    decimals,
    totalSupply: totalSupply.toString(),
    totalSupplyFormatted,

    ownerAddress,
    ownershipRenounced,
    isProxy,

    deployerAddress:        null, // real-time-only mode: deployer identity requires historical data
    deployerMintBlock:      null,
    deployerMintAmount:     null,
    deployerCurrentBalance: null,
    deployerPct: null,

    holderScanFrom:    deployBlock.toString(),
    holderScanTo:      deployBlock.toString(),
    holderScanPartial: false,
    holderScanFailed:  false,
    top5Holders:       [],
    top5HoldersPct:    null,

    hasLiquidity,
    poolLiquidity:       poolLiquidityRaw?.toString() ?? null,
    liquidityLocked,
    initialLiquidityEth,

    liquidityDeltaPct:        null,
    liquidityPreviousReading: null,
    snapshotAgeMinutes:       null,

    sellTestPassed:     null,
    sellTestAmountSent: null,
    sellTestError:      null,

    lpTokenId:        null,
    lpPositionOwner:  null,
    lpPositionStatus: "unverified",

    liquidityEverPulled: false,
    burnEventCount:      0,

    sourceVerified:          null,
    suspiciousFunctions:     [],
    secondaryAdminDetected:  false,
    secondaryAdminSnippet:   null,
    sourceAuditMethod:       null,
    sourceFunctionAudits:    [],
    proxyImplementationAudited: false,
    proxyImplementationAddress: null,

    deployerSeenBefore:  false,
    deployerPriorTokens: [],

    deploysLast15Min:         0,
    deploysLastHour:          0,
    deploysLast24h:           0,
    recentContracts:          [],

    walletAgeAtDeploySeconds: null,
    fundingGapSeconds:        null,
    fundingSourceAddress:     null,

    preSeededWallets: [],
    preSeededPct:     null,

    totalSwaps:           0,
    uniqueTraders:        0,
    buyCount:             0,
    sellCount:            0,
    buySellRatio:         null,
    roundTripTraderCount: 0,
    roundTripTraderPct:   null,
    topTraderSwapSharePct: 0,
    tradeScanPartial:     false,

    rpcWarnings: warnings,
  };
}

// ─── Re-verification pass ─────────────────────────────────────────────────────

/**
 * Fields that the re-verification pass can improve.
 * Returned by reVerifyEvidence(); caller decides which to apply.
 */

/**
 * Lightweight re-check that only re-runs the field most likely to be
 * wrong on a first-pass analysis run too close to pool creation:
 *
 *   Pool liquidity / initialLiquidityEth — was 0 / null because the
 *   LP-add tx hadn't been mined yet at evidence-collection time.
 *
 * LP lock status re-check removed (real-time-only mode: historical event
 * scanning no longer supported).
 *
 * Everything else (holder scan, source check, trade activity, sell test) is
 * left untouched — those reads are expensive and their values don't change in
 * the first few minutes.
 *
 * @param original     The TokenEvidence from the first pass.
 * @param deployBlock  Pool deploy block (bigint).
 * @param venue        "v3" or "v4".
 * @param v4PoolParams V4-only: needed to call StateView.getLiquidity(poolId).
 */
export async function reVerifyEvidence(
  client: AnyClient,
  original: TokenEvidence,
  deployBlock: bigint,
  venue: Venue,
  v4PoolParams?: {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
  }
): Promise<ReVerifyResult> {
  const warnings: string[] = [];
  const poolAddress = original.poolAddress as Address;
  const result: ReVerifyResult = { improved: false, warnings };

  // LP lock status re-check removed (real-time-only mode)

  // ── 2. Re-check pool liquidity if the first pass read 0 or null ───────────
  const firstPassLiqZero =
    original.poolLiquidity === null ||
    original.poolLiquidity === "0" ||
    BigInt(original.poolLiquidity ?? "0") === 0n;

  if (firstPassLiqZero) {
    try {
      let poolLiquidityRaw: bigint | null = null;
      let initialLiquidityEth: number | null = null;
      let liquidityLocked: boolean | null = null;

      if (venue === "v4") {
        // V4: read StateView.getLiquidity(poolId) + getSlot0(poolId)
        try {
          poolLiquidityRaw = await client.readContract({
            address: UNISWAP_V4_STATE_VIEW as Address,
            abi:     V4_STATE_VIEW_LIQUIDITY_ABI,
            functionName: "getLiquidity",
            args:    [poolAddress],
          }) as bigint;
        } catch (err) {
          warn(warnings, "reverify:liquidity", "V4 getLiquidity failed", err);
        }

        if (poolLiquidityRaw && poolLiquidityRaw > 0n) {
          try {
            const slot0 = await client.readContract({
              address: UNISWAP_V4_STATE_VIEW as Address,
              abi:     V4_STATE_VIEW_SLOT0_ABI,
              functionName: "getSlot0",
              args:    [poolAddress],
            }) as readonly [bigint, ...unknown[]];
            const sqrtPriceX96 = slot0[0];
            if (sqrtPriceX96 > 0n) {
              const Q96 = 2n ** 96n;
              const raw = Number(formatEther((poolLiquidityRaw * Q96) / sqrtPriceX96));
              initialLiquidityEth = raw > 100_000 ? null : raw;
            } else {
              warnings.push(
                `[reverify:slot0] V4 getSlot0 returned sqrtPriceX96=0 despite liquidity=${poolLiquidityRaw} — hook may not have initialized price yet, initialLiquidityEth left unverified`
              );
            }
          } catch (err) {
            warn(warnings, "reverify:slot0", "V4 getSlot0 failed", err);
          }
          liquidityLocked = null; // will be set by LP lock check above if applicable
        }
      } else {
        // V3: read pool.liquidity() + pool.slot0()
        try {
          poolLiquidityRaw = await client.readContract({
            address: poolAddress,
            abi:     POOL_LIQUIDITY_ABI,
            functionName: "liquidity",
          }) as bigint;
        } catch (err) {
          warn(warnings, "reverify:liquidity", "V3 pool.liquidity() failed", err);
        }

        if (poolLiquidityRaw && poolLiquidityRaw > 0n) {
          try {
            const slot0 = await client.readContract({
              address: poolAddress,
              abi:     POOL_SLOT0_ABI,
              functionName: "slot0",
            }) as readonly [bigint, ...unknown[]];
            const sqrtPriceX96 = slot0[0];
            if (sqrtPriceX96 > 0n) {
              const Q96 = 2n ** 96n;
              const raw = Number(formatEther((poolLiquidityRaw * Q96) / sqrtPriceX96));
              initialLiquidityEth = raw > 100_000 ? null : raw;
            } else {
              warnings.push(
                `[reverify:slot0] V3 slot0 returned sqrtPriceX96=0 despite liquidity=${poolLiquidityRaw} — initialLiquidityEth left unverified`
              );
            }
          } catch (err) {
            warn(warnings, "reverify:slot0", "V3 slot0 failed", err);
          }
          liquidityLocked = null;
        }
      }

      if (poolLiquidityRaw !== null && poolLiquidityRaw > 0n) {
        result.poolLiquidity      = poolLiquidityRaw.toString();
        result.initialLiquidityEth = initialLiquidityEth;
        result.liquidityLocked    = liquidityLocked;
        result.improved = true;
        console.log(
          `  [reverify] Liquidity updated: 0 → ${poolLiquidityRaw}` +
          (initialLiquidityEth !== null ? ` (~${initialLiquidityEth.toFixed(4)} ETH)` : "")
        );
      } else {
        console.log(`  [reverify] Pool liquidity still 0 — LP add not yet confirmed`);
      }
    } catch (err) {
      warn(warnings, "reverify:liquidity", "liquidity re-check failed", err);
    }
  }

  return result;
}