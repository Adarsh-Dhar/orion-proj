/**
 * evidence.ts — pure on-chain data collection, no scoring.
 *
 * Exports:
 *   collectEvidence(client, tokenAddress, poolAddress, pairedAsset, deployBlock)
 *     → TokenEvidence
 *
 * All RPC failures are logged to stdout AND recorded in `rpcWarnings[]` so
 * the LLM scorer can see which fields are unverified rather than treating
 * nulls as implicitly clean.
 *
 * Key fix vs old rugcheck.ts:
 *   getHolderBalances now resolves "latest" explicitly via getBlockNumber(),
 *   then walks FORWARD in SCAN_CHUNK (10k-block) windows rather than making
 *   one unbounded call. This eliminates the "range exceeds limit" error that
 *   broke every historical scan.
 */

import { type Address, formatEther, encodeFunctionData, parseEventLogs } from "viem";
import type { PublicClient } from "viem";
import type { BotState, LiquiditySnapshot } from "./state.js";
import { recordLiquiditySnapshot, saveState } from "./state.js";
import {
  OWNER_ABI,
  NULL_ADDRESS,
  EIP1967_IMPL_SLOT,
  POOL_SLOT0_ABI,
  POOL_LIQUIDITY_ABI,
  POOL_TOKENS_ABI,
  TRANSFER_EVENT_ABI,
  ERC20_ABI,
  // new:
  UNISWAP_V3_POSITION_MANAGER,
  UNCX_V3_LOCKER,
  BURN_ADDRESS,
  ETHERSCAN_API_BASE,
  BASE_CHAIN_ID,
  POOL_MINT_EVENT_ABI,
  POOL_BURN_EVENT_ABI,
  POOL_SWAP_EVENT_ABI,
  NPM_INCREASE_LIQUIDITY_EVENT_ABI,
  NPM_OWNER_OF_ABI,
  ERC20_TRANSFER_ABI,
  SUSPICIOUS_SOURCE_KEYWORDS,
  PRIVILEGE_KEYWORDS,
} from "./constants.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

const SCAN_CHUNK   = 10_000n;
const MAX_LOOKBACK = 200_000n;
const ZERO_SLOT    =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// ─── TokenEvidence ────────────────────────────────────────────────────────────

/**
 * All numbers that could overflow JSON's float precision are stored as
 * strings. The LLM receives this object serialised as JSON so bigint →
 * string conversion is done here, not in the scorer.
 */
export interface TokenEvidence {
  // ── Identity ──────────────────────────────────────────────────────────────
  tokenAddress: string;
  poolAddress: string;
  pairedAsset: string;
  deployBlock: string;   // bigint as string

  // ── ERC-20 metadata ───────────────────────────────────────────────────────
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;           // bigint as string
  totalSupplyFormatted: string;  // human-readable with decimals

  // ── Ownership ─────────────────────────────────────────────────────────────
  ownerAddress: string | null;   // null = call failed
  ownershipRenounced: boolean | null;
  isProxy: boolean | null;       // null = storage read failed

  // ── Deployer / wallet distribution ────────────────────────────────────────
  deployerAddress: string | null;
  deployerMintBlock: string | null;   // bigint as string
  deployerMintAmount: string | null;  // bigint as string — original mint qty
  deployerCurrentBalance: string | null; // bigint as string — from holder scan
  deployerPct: number | null;         // % of total supply; null = unverified

  // Holder scan metadata
  holderScanFrom: string;    // bigint as string
  holderScanTo: string;      // bigint as string
  holderScanPartial: boolean; // true if some chunks failed
  holderScanFailed: boolean;  // true if ALL chunks failed
  top5Holders: Array<{ address: string; balance: string; pct: number }>;
  top5HoldersPct: number | null;

  // ── Liquidity ─────────────────────────────────────────────────────────────
  poolLiquidity: string | null;      // bigint as string; null = read failed
  liquidityLocked: boolean | null;   // null = unknown
  initialLiquidityEth: number | null;

  // ── Liquidity delta monitoring ─────────────────────────────────────────────
  liquidityDeltaPct: number | null;       // % change since last snapshot
  liquidityPreviousReading: string | null; // previous liquidity value
  snapshotAgeMinutes: number | null;      // minutes since last snapshot

  // ── Sell-ability (honeypot) ─────────────────────────────────────────────
  sellTestPassed: boolean | null;      // null = couldn't run the test at all
  sellTestAmountSent: string | null;
  sellTestError: string | null;

  // ── LP position lock status ─────────────────────────────────────────────
  lpTokenId: string | null;
  lpPositionOwner: string | null;
  lpPositionStatus: "burned" | "locked_uncx" | "held_by_eoa" | "non_nft_position" | "unverified";

  // ── Liquidity pull history ──────────────────────────────────────────────
  liquidityEverPulled: boolean;
  burnEventCount: number;

  // ── Source verification ─────────────────────────────────────────────────
  sourceVerified: boolean | null;      // null = the Etherscan call itself failed
  suspiciousFunctions: {name: string, snippet: string}[];
  secondaryAdminDetected: boolean;
  secondaryAdminSnippet: string | null;

  // ── Deployer history (in-process memory, resets on bot restart) ────────
  deployerSeenBefore: boolean;
  deployerPriorTokens: string[];

  // ── Trade activity (wash trading detection) ────────────────────────────
  totalSwaps: number;
  uniqueTraders: number;
  buyCount: number;
  sellCount: number;
  buySellRatio: number | null; // buyCount / sellCount, null if sellCount = 0
  roundTripTraderCount: number; // addresses that both bought AND sold
  roundTripTraderPct: number | null; // % of unique traders that round-tripped
  topTraderSwapSharePct: number; // e.g. 68% = one wallet did 68% of all swaps
  tradeScanPartial: boolean;

  // ── RPC warnings ──────────────────────────────────────────────────────────
  /** Every failed RPC call during collection. The LLM must treat any field
   *  that appears in this list as "unverified" rather than as a clean signal. */
  rpcWarnings: string[];
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function warn(warnings: string[], tag: string, context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
  const entry = `[${tag}] ${context}: ${msg}`;
  console.warn(`  [evidence:${tag}] ${context}: ${msg}`);
  warnings.push(entry);
}

async function safeRead<T>(
  fn: () => Promise<T>,
  fallback: T,
  tag: string,
  warnings: string[]
): Promise<T> {
  try { return await fn(); }
  catch (err) { warn(warnings, tag, "read failed, using fallback", err); return fallback; }
}

async function safeReadNullable<T>(
  fn: () => Promise<T>,
  tag: string,
  warnings: string[]
): Promise<T | null> {
  try { return await fn(); }
  catch (err) { warn(warnings, tag, "read failed", err); return null; }
}

// ─── Deployer finder ─────────────────────────────────────────────────────────

interface DeployerResult {
  address: string | null;
  mintBlock: bigint | null;
  mintAmount: bigint | null;
  source: "tight" | "wide" | "unknown";
}

export async function findDeployer(
  client: AnyClient,
  tokenAddress: Address,
  deployBlock: bigint,
  warnings: string[]
): Promise<DeployerResult> {
  const MINT_LOOKBACK = 500n;
  const tightFrom = deployBlock > MINT_LOOKBACK ? deployBlock - MINT_LOOKBACK : 0n;

  // Pass 1 — tight window around pool creation
  try {
    const logs = await client.getLogs({
      address: tokenAddress,
      event: TRANSFER_EVENT_ABI[0],
      args: { from: NULL_ADDRESS as Address },
      fromBlock: tightFrom,
      toBlock: deployBlock,
    });
    if (logs.length > 0) {
      const sorted = [...logs].sort((a, b) => (a.blockNumber! < b.blockNumber! ? -1 : 1));
      const first  = sorted[0];
      const to     = (first.args as { to: string }).to ?? null;
      const value  = (first.args as { value?: bigint }).value ?? null;
      return { address: to, mintBlock: first.blockNumber ?? null, mintAmount: value, source: "tight" };
    }
  } catch (err) {
    warn(warnings, "findDeployer", `tight-window [${tightFrom}, ${deployBlock}] failed`, err);
  }

  // Pass 2 — walk backwards in 10k-block chunks up to 200k blocks
  const hardFloor = deployBlock > MAX_LOOKBACK ? deployBlock - MAX_LOOKBACK : 0n;
  let chunkEnd = tightFrom > 1n ? tightFrom - 1n : 0n;

  while (chunkEnd > hardFloor) {
    const chunkStart = chunkEnd > SCAN_CHUNK ? chunkEnd - SCAN_CHUNK : 0n;
    try {
      const logs = await client.getLogs({
        address: tokenAddress,
        event: TRANSFER_EVENT_ABI[0],
        args: { from: NULL_ADDRESS as Address },
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });
      if (logs.length > 0) {
        const sorted = [...logs].sort((a, b) => (a.blockNumber! < b.blockNumber! ? -1 : 1));
        const first  = sorted[0];
        const to     = (first.args as { to: string }).to ?? null;
        const value  = (first.args as { value?: bigint }).value ?? null;
        return { address: to, mintBlock: first.blockNumber ?? null, mintAmount: value, source: "wide" };
      }
    } catch (err) {
      warn(warnings, "findDeployer", `wide chunk [${chunkStart}, ${chunkEnd}] failed`, err);
    }
    if (chunkStart === 0n) break;
    chunkEnd = chunkStart - 1n;
  }

  return { address: null, mintBlock: null, mintAmount: null, source: "unknown" };
}

// ─── Holder balance scan ──────────────────────────────────────────────────────

interface HolderScanResult {
  balances: Map<string, bigint>;
  partial: boolean;   // some chunks failed but we have some data
  failed: boolean;    // all chunks failed, map is empty
  scanFrom: bigint;
  scanTo: bigint;
}

/**
 * Fetch holder balances by scanning Transfer events from `fromBlock` to the
 * current chain head, walking forward in SCAN_CHUNK (10k) windows.
 *
 * This replaces the old single getLogs({ toBlock: "latest" }) call which
 * always failed with "range exceeds limit" on any scan more than 10k blocks
 * from the current head — which is true of all historical tokens.
 */
export async function scanHolderBalances(
  client: AnyClient,
  tokenAddress: Address,
  fromBlock: bigint,
  warnings: string[]
): Promise<HolderScanResult> {
  const latestBlock = await client.getBlockNumber();
  const balances    = new Map<string, bigint>();
  let chunksFailed  = 0;
  let chunksTotal   = 0;

  for (let chunkStart = fromBlock; chunkStart <= latestBlock; chunkStart += SCAN_CHUNK) {
    const chunkEnd = chunkStart + SCAN_CHUNK - 1n < latestBlock
      ? chunkStart + SCAN_CHUNK - 1n
      : latestBlock;

    chunksTotal++;
    try {
      const logs = await client.getLogs({
        address: tokenAddress,
        event: TRANSFER_EVENT_ABI[0],
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });
      for (const log of logs) {
        const args = log.args as { from: string; to: string; value: bigint };
        const { from, to, value } = args;
        if (!value) continue;
        if (from !== NULL_ADDRESS) {
          balances.set(from, (balances.get(from) ?? 0n) - value);
        }
        balances.set(to, (balances.get(to) ?? 0n) + value);
      }
    } catch (err) {
      chunksFailed++;
      warn(warnings, "holderScan", `chunk [${chunkStart}, ${chunkEnd}] failed`, err);
    }
  }

  // Remove dust / burned balances
  for (const [addr, bal] of balances) {
    if (bal <= 0n) balances.delete(addr);
  }

  return {
    balances,
    partial: chunksFailed > 0 && chunksFailed < chunksTotal,
    failed:  chunksFailed === chunksTotal && chunksTotal > 0,
    scanFrom: fromBlock,
    scanTo:   latestBlock,
  };
}

// ── Deployer history check (now uses persistent state) ──────────────────────
// This function is no longer used directly — deployer history is now managed
// through the persistent BotState in state.ts to survive bot restarts.
// Kept here for backwards compatibility, but the real implementation is in rugcheck.ts

// ── Liquidity delta check ─────────────────────────────────────────────────────
export async function checkLiquidityDelta(
  client: AnyClient,
  poolAddress: Address,
  state: BotState
): Promise<{ liquidityDeltaPct: number | null; liquidityPreviousReading: string | null; snapshotAgeMinutes: number | null; currentSnapshot: LiquiditySnapshot }> {
  const history = state.liquidityHistory[poolAddress.toLowerCase()] ?? [];
  const prev = history[history.length - 1];
  const current = await client.readContract({ address: poolAddress, abi: POOL_LIQUIDITY_ABI, functionName: "liquidity" }) as bigint;

  const snap: LiquiditySnapshot = {
    liquidity: current.toString(),
    blockNumber: (await client.getBlockNumber()).toString(),
    ts: Date.now(),
  };

  // Don't save state here - let the caller handle that to avoid excessive writes
  if (!prev) return { liquidityDeltaPct: null, liquidityPreviousReading: null, snapshotAgeMinutes: null, currentSnapshot: snap };

  const prevVal = BigInt(prev.liquidity);
  const deltaPct = prevVal === 0n ? null : Number(((current - prevVal) * 10000n) / prevVal) / 100;
  return {
    liquidityDeltaPct: deltaPct,
    liquidityPreviousReading: prev.liquidity,
    snapshotAgeMinutes: Math.round((Date.now() - prev.ts) / 60000),
    currentSnapshot: snap,
  };
}

// ── 1. Sell-ability / honeypot test ──────────────────────────────────────
export async function testSellability(
  client: AnyClient,
  tokenAddress: Address,
  poolAddress: Address,
  top5: Array<{ address: string; balance: string }>,
  ownerAddress: string | null,
  deployerAddress: string | null,
  warnings: string[]
): Promise<{ sellTestPassed: boolean | null; sellTestAmountSent: string | null; sellTestError: string | null }> {
  const candidate = top5.find(
    (h) =>
      h.address.toLowerCase() !== NULL_ADDRESS.toLowerCase() &&
      h.address.toLowerCase() !== BURN_ADDRESS.toLowerCase() &&
      (ownerAddress === null || h.address.toLowerCase() !== ownerAddress.toLowerCase()) &&
      (deployerAddress === null || h.address.toLowerCase() !== deployerAddress.toLowerCase()) &&
      BigInt(h.balance) > 0n
  );
  if (!candidate) {
    return { sellTestPassed: null, sellTestAmountSent: null, sellTestError: "only privileged wallets hold balance — test would be meaningless" };
  }
  const balance = BigInt(candidate.balance);
  const testAmount = balance / 1000n > 0n ? balance / 1000n : balance; // 0.1% or the whole balance if tiny

  try {
    await client.call({
      account: candidate.address as Address,
      to: tokenAddress,
      data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [poolAddress, testAmount] }),
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
 * This is the agent-friendly wrapper that allows the LLM to specify which holder
 * to test and what percentage of their balance to sell.
 */
export async function runSellTest(
  client: AnyClient,
  tokenAddress: Address,
  poolAddress: Address,
  holderAddress: Address,
  amountPct: number,
  warnings: string[]
): Promise<{ sellTestPassed: boolean | null; sellTestAmountSent: string | null; sellTestError: string | null }> {
  // Get the holder's current balance
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

  // Calculate test amount based on percentage
  const testAmount = (balance * BigInt(Math.floor(amountPct * 100))) / 10000n;
  if (testAmount === 0n) {
    return { sellTestPassed: null, sellTestAmountSent: null, sellTestError: "calculated test amount is zero" };
  }

  try {
    await client.call({
      account: holderAddress,
      to: tokenAddress,
      data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [poolAddress, testAmount] }),
    });
    return { sellTestPassed: true, sellTestAmountSent: testAmount.toString(), sellTestError: null };
  } catch (err) {
    warn(warnings, "sellTest", "simulated transfer to pool reverted", err);
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { sellTestPassed: false, sellTestAmountSent: testAmount.toString(), sellTestError: message };
  }
}

// ── 2. LP position lock/burn status ──────────────────────────────────────
export async function checkLpLockStatus(
  client: AnyClient,
  poolAddress: Address,
  deployBlock: bigint,
  warnings: string[]
): Promise<{ lpTokenId: string | null; lpPositionOwner: string | null; lpPositionStatus: TokenEvidence["lpPositionStatus"] }> {
  try {
    const mintLogs = await client.getLogs({
      address: poolAddress,
      event: POOL_MINT_EVENT_ABI[0],
      fromBlock: deployBlock,
      toBlock: deployBlock + 200n,
    });
    if (mintLogs.length === 0) {
      return { lpTokenId: null, lpPositionOwner: null, lpPositionStatus: "unverified" };
    }

    const mintLog = mintLogs[0];
    const mintOwner = (mintLog.args as { owner: string }).owner;

    if (mintOwner.toLowerCase() !== UNISWAP_V3_POSITION_MANAGER.toLowerCase()) {
      // Liquidity added directly, bypassing the standard NFT flow — no
      // position NFT to check; that same address controls the liquidity.
      return { lpTokenId: null, lpPositionOwner: mintOwner, lpPositionStatus: "non_nft_position" };
    }

    const receipt = await client.getTransactionReceipt({ hash: mintLog.transactionHash! });
    const increaseLogs = parseEventLogs({ abi: NPM_INCREASE_LIQUIDITY_EVENT_ABI, logs: receipt.logs });
    const npmLog = increaseLogs.find((l) => l.address.toLowerCase() === UNISWAP_V3_POSITION_MANAGER.toLowerCase());

    if (!npmLog) {
      return { lpTokenId: null, lpPositionOwner: mintOwner, lpPositionStatus: "unverified" };
    }

    const tokenId = (npmLog.args as { tokenId: bigint }).tokenId;
    const owner = (await client.readContract({
      address: UNISWAP_V3_POSITION_MANAGER,
      abi: NPM_OWNER_OF_ABI,
      functionName: "ownerOf",
      args: [tokenId],
    })) as string;

    let status: TokenEvidence["lpPositionStatus"];
    if (owner.toLowerCase() === BURN_ADDRESS.toLowerCase()) status = "burned";
    else if (owner.toLowerCase() === UNCX_V3_LOCKER.toLowerCase()) status = "locked_uncx";
    else status = "held_by_eoa";

    return { lpTokenId: tokenId.toString(), lpPositionOwner: owner, lpPositionStatus: status };
  } catch (err) {
    warn(warnings, "lpLock", "position lookup failed", err);
    return { lpTokenId: null, lpPositionOwner: null, lpPositionStatus: "unverified" };
  }
}

// ── 3. Liquidity pull history (Burn event scan) ──────────────────────────
export async function checkLiquidityPullHistory(
  client: AnyClient,
  poolAddress: Address,
  deployBlock: bigint,
  currentBlock: bigint,
  warnings: string[]
): Promise<{ liquidityEverPulled: boolean; burnEventCount: number }> {
  let count = 0;
  let chunkStart = deployBlock;
  while (chunkStart <= currentBlock) {
    const chunkEnd = chunkStart + SCAN_CHUNK - 1n < currentBlock ? chunkStart + SCAN_CHUNK - 1n : currentBlock;
    try {
      const logs = await client.getLogs({
        address: poolAddress,
        event: POOL_BURN_EVENT_ABI[0],
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });
      count += logs.length;
    } catch (err) {
      warn(warnings, "burnHistory", `chunk [${chunkStart}, ${chunkEnd}] failed`, err);
    }
    chunkStart = chunkEnd + 1n;
  }
  return { liquidityEverPulled: count > 0, burnEventCount: count };
}

// ── Trade activity scan (wash trading detection) ───────────────────────
interface TradeActivity {
  totalSwaps: number;
  uniqueTraders: number;
  buyCount: number;
  sellCount: number;
  buyerAddresses: Set<string>;
  sellerAddresses: Set<string>;
  // wash-trading signal: addresses that appear on BOTH sides
  roundTripTraders: string[];
  topTraderSwapShare: number; // % of total swaps done by the single busiest address
  scanPartial: boolean;
}

export async function scanTradeActivity(
  client: AnyClient,
  poolAddress: Address,
  fromBlock: bigint,
  token0IsTarget: boolean, // which side of the pool is the token being checked
  warnings: string[]
): Promise<TradeActivity> {
  const latestBlock = await client.getBlockNumber();
  const swapsByAddress = new Map<string, { buys: number; sells: number }>();
  let chunksFailed = 0, chunksTotal = 0, totalSwaps = 0;

  for (let chunkStart = fromBlock; chunkStart <= latestBlock; chunkStart += SCAN_CHUNK) {
    const chunkEnd = chunkStart + SCAN_CHUNK - 1n < latestBlock ? chunkStart + SCAN_CHUNK - 1n : latestBlock;
    chunksTotal++;
    try {
      const logs = await client.getLogs({
        address: poolAddress,
        event: POOL_SWAP_EVENT_ABI[0],
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });
      for (const log of logs) {
        const { recipient, amount0, amount1 } = log.args as {
          recipient: string; amount0: bigint; amount1: bigint;
        };
        totalSwaps++;
        // Negative amount = pool sending that token out = the trader received it (a buy of that token)
        const targetAmount = token0IsTarget ? amount0 : amount1;
        const isBuy = targetAmount < 0n;
        const entry = swapsByAddress.get(recipient) ?? { buys: 0, sells: 0 };
        if (isBuy) entry.buys++; else entry.sells++;
        swapsByAddress.set(recipient, entry);
      }
    } catch (err) {
      chunksFailed++;
      warn(warnings, "tradeScan", `chunk [${chunkStart}, ${chunkEnd}] failed`, err);
    }
  }

  const buyerAddresses = new Set<string>();
  const sellerAddresses = new Set<string>();
  const roundTripTraders: string[] = [];
  let buyCount = 0, sellCount = 0, maxSwapsForOne = 0;

  for (const [addr, { buys, sells }] of swapsByAddress) {
    buyCount += buys; sellCount += sells;
    if (buys > 0) buyerAddresses.add(addr);
    if (sells > 0) sellerAddresses.add(addr);
    if (buys > 0 && sells > 0) roundTripTraders.push(addr);
    maxSwapsForOne = Math.max(maxSwapsForOne, buys + sells);
  }

  return {
    totalSwaps,
    uniqueTraders: swapsByAddress.size,
    buyCount,
    sellCount,
    buyerAddresses,
    sellerAddresses,
    roundTripTraders,
    topTraderSwapShare: totalSwaps > 0 ? (maxSwapsForOne / totalSwaps) * 100 : 0,
    scanPartial: chunksFailed > 0,
  };
}

// ── Helper: extract function body from source code ───────────────────────
function extractFunctionBody(source: string, keyword: string): string | null {
  // Find the function that contains this keyword
  const functionPattern = /function\s+(\w+)[^{]*\{/g;
  let match: RegExpExecArray | null;
  const maxLines = 40;
  const lines = source.split('\n');
  
  while ((match = functionPattern.exec(source)) !== null) {
    const funcStartIndex = match.index;
    const funcStartLine = source.substring(0, funcStartIndex).split('\n').length - 1;
    
    // Check if this function contains the keyword
    const funcEnd = findMatchingBrace(source, funcStartIndex + match[0].length - 1);
    if (funcEnd === null) continue;
    
    const funcBody = source.substring(funcStartIndex, funcEnd + 1);
    if (funcBody.includes(keyword)) {
      // Extract up to maxLines
      const funcLines = funcBody.split('\n');
      if (funcLines.length <= maxLines) {
        return funcBody;
      }
      return funcLines.slice(0, maxLines).join('\n') + '\n  // ... (truncated)';
    }
  }
  
  return null;
}

// ── Helper: find matching closing brace ─────────────────────────────────
function findMatchingBrace(source: string, startIndex: number): number | null {
  let braceCount = 0;
  for (let i = startIndex; i < source.length; i++) {
    if (source[i] === '{') braceCount++;
    else if (source[i] === '}') {
      braceCount--;
      if (braceCount === 0) return i;
    }
  }
  return null;
}

// ── Helper: detect secondary admin after renounce ───────────────────────
function detectSecondaryAdmin(
  source: string,
  renouncedOwner: string | null
): { detected: boolean; snippet: string | null } {
  if (!renouncedOwner || renouncedOwner === "unknown") {
    return { detected: false, snippet: null };
  }
  
  // Extract all address-type state variables (potential admin roles)
  const addressVarPattern = /address\s+(?:public|private|internal)?\s*(\w+)\s*(?:=|;)/gi;
  const addressVars: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = addressVarPattern.exec(source)) !== null) {
    const varName = match[1];
    // Skip owner-related variables (these are expected)
    if (!varName.toLowerCase().includes('owner') && 
        !varName.toLowerCase().includes('pending')) {
      addressVars.push(varName);
    }
  }
  
  if (addressVars.length === 0) {
    return { detected: false, snippet: null };
  }
  
  // Find all functions/modifiers that use privilege keywords
  const functionPattern = /(?:function|modifier)\s+(\w+)[^{]*\{/g;
  const privilegedFunctions: Array<{name: string, body: string}> = [];
  
  while ((match = functionPattern.exec(source)) !== null) {
    const funcName = match[1];
    const funcStart = match.index;
    const funcBodyStart = funcStart + match[0].length - 1;
    const funcEnd = findMatchingBrace(source, funcBodyStart);
    
    if (funcEnd !== null) {
      const funcBody = source.substring(funcStart, funcEnd + 1);
      
      // Check if this function uses any privilege keyword
      for (const keyword of PRIVILEGE_KEYWORDS) {
        const keywordRegex = new RegExp(keyword, 'gi');
        if (keywordRegex.test(funcBody)) {
          privilegedFunctions.push({ name: funcName, body: funcBody });
          break;
        }
      }
    }
  }
  
  // Check if any privileged function is gated by a non-owner address variable
  for (const func of privilegedFunctions) {
    for (const addrVar of addressVars) {
      // Look for this address variable being used in a require/check
      const varUsagePattern = new RegExp(`require\\s*\\([^)]*${addrVar}[^)]*\\)|if\\s*\\([^)]*${addrVar}[^)]*\\)`, 'gi');
      if (varUsagePattern.test(func.body)) {
        // Found a privileged function gated by a secondary address variable
        const snippet = func.body.split('\n').slice(0, 8).join('\n').trim();
        return {
          detected: true,
          snippet: snippet.length > 300 ? snippet.substring(0, 300) + '...' : snippet
        };
      }
    }
  }
  
  return { detected: false, snippet: null };
}

// ── 4. Source verification + backdoor keyword scan ──────────────────────
export async function checkSourceVerification(
  tokenAddress: Address,
  warnings: string[],
  ownershipRenounced: boolean | null,
  ownerAddress: string | null
): Promise<{ 
  sourceVerified: boolean | null; 
  suspiciousFunctions: {name: string, snippet: string}[];
  secondaryAdminDetected: boolean;
  secondaryAdminSnippet: string | null;
}> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    warn(warnings, "sourceCheck", "ETHERSCAN_API_KEY not set — skipping", "missing env var");
    return { sourceVerified: null, suspiciousFunctions: [], secondaryAdminDetected: false, secondaryAdminSnippet: null };
  }
  try {
    const url = `${ETHERSCAN_API_BASE}?chainid=${BASE_CHAIN_ID}&module=contract&action=getsourcecode&address=${tokenAddress}&apikey=${apiKey}`;
    const res = await fetch(url);
    const json = await res.json();
    const source: string = json?.result?.[0]?.SourceCode ?? "";
    if (!source) {
      return { sourceVerified: false, suspiciousFunctions: [], secondaryAdminDetected: false, secondaryAdminSnippet: null };
    }
    
    // Extract function bodies for each suspicious keyword found
    const suspiciousFunctions: {name: string, snippet: string}[] = [];
    for (const kw of SUSPICIOUS_SOURCE_KEYWORDS) {
      if (source.includes(kw)) {
        const snippet = extractFunctionBody(source, kw);
        if (snippet) {
          // Try to extract function name from the snippet
          const nameMatch = snippet.match(/function\s+(\w+)/);
          const funcName = nameMatch ? nameMatch[1] : "unknown";
          suspiciousFunctions.push({ name: funcName, snippet });
        } else {
          // Fallback if we can't extract the function body
          suspiciousFunctions.push({ name: kw, snippet: `// Keyword "${kw}" found but function body extraction failed` });
        }
      }
    }
    
    // Check for secondary admin if ownership is renounced
    let secondaryAdminDetected = false;
    let secondaryAdminSnippet: string | null = null;
    if (ownershipRenounced === true && ownerAddress) {
      const adminCheck = detectSecondaryAdmin(source, ownerAddress);
      secondaryAdminDetected = adminCheck.detected;
      secondaryAdminSnippet = adminCheck.snippet;
    }
    
    return { 
      sourceVerified: true, 
      suspiciousFunctions,
      secondaryAdminDetected,
      secondaryAdminSnippet
    };
  } catch (err) {
    warn(warnings, "sourceCheck", "Etherscan API call failed", err);
    return { sourceVerified: null, suspiciousFunctions: [], secondaryAdminDetected: false, secondaryAdminSnippet: null };
  }
}

// ─── Main collection function ─────────────────────────────────────────────────

export async function collectEvidence(
  client: AnyClient,
  tokenAddress: Address,
  poolAddress: Address,
  pairedAsset: string,
  deployBlock: bigint,
  /** pre-fetched ERC-20 metadata (avoids a second round of reads) */
  meta: { name: string; symbol: string; decimals: number; totalSupply: bigint; totalSupplyFormatted: string },
  /** optional deployer history from persistent state */
  deployerHistory?: { deployerSeenBefore: boolean; deployerPriorTokens: string[] },
  /** optional state for liquidity delta monitoring */
  state?: BotState
): Promise<TokenEvidence> {
  const warnings: string[] = [];

  // ── 1. ERC-20 supply / decimals (already in meta, just surface them) ──────
  const { name, symbol, decimals, totalSupply, totalSupplyFormatted } = meta;

  // ── 2. Ownership ───────────────────────────────────────────────────────────
  let ownerAddress: string | null = null;
  let ownershipRenounced: boolean | null = null;
  try {
    ownerAddress = await client.readContract({
      address: tokenAddress,
      abi: OWNER_ABI,
      functionName: "owner",
    }) as string;
    ownershipRenounced = ownerAddress === NULL_ADDRESS;
  } catch (err) {
    warn(warnings, "owner", "owner() call failed", err);
  }

  // ── 3. Proxy check ─────────────────────────────────────────────────────────
  let isProxy: boolean | null = null;
  try {
    const slot = await client.getStorageAt({ address: tokenAddress, slot: EIP1967_IMPL_SLOT });
    isProxy = slot !== undefined ? slot !== ZERO_SLOT : null;
  } catch (err) {
    warn(warnings, "proxy", "EIP-1967 slot read failed", err);
  }

  // ── 4. Deployer (mint event scan) ─────────────────────────────────────────
  const deployer = await findDeployer(client, tokenAddress, deployBlock, warnings);

  // ── 5. Holder balances ─────────────────────────────────────────────────────
  // Anchor the holder scan from the mint block if we found it (most accurate),
  // otherwise from deployBlock - 10k (conservative fallback).
  const holderScanFrom = deployer.mintBlock !== null
    ? deployer.mintBlock
    : deployBlock > 10_000n ? deployBlock - 10_000n : 0n;

  const holderScan = await scanHolderBalances(client, tokenAddress, holderScanFrom, warnings);

  // Deployer's current balance from the holder scan
  let deployerCurrentBalance: bigint | null = null;
  if (!holderScan.failed && deployer.address) {
    deployerCurrentBalance = holderScan.balances.get(deployer.address.toLowerCase()) ?? 0n;
  }

  // If we found the deployer via wide scan and their mint predates the holder
  // scan window, the current balance will be 0 (transfer not in range) —
  // fall back to mint amount as a floor estimate and record it.
  if (
    deployer.source === "wide" &&
    deployer.mintBlock !== null &&
    deployer.mintBlock < holderScanFrom &&
    deployerCurrentBalance === 0n &&
    deployer.mintAmount !== null
  ) {
    deployerCurrentBalance = deployer.mintAmount;
    warnings.push(
      "[holderScan] deployer balance is a floor estimate — mint predates scan window"
    );
  }

  const deployerPct: number | null =
    deployer.address && totalSupply > 0n && deployerCurrentBalance !== null
      ? Number((deployerCurrentBalance * 10_000n) / totalSupply) / 100
      : null;

  // Top-5 holders (excluding the pool address itself)
  const sortedHolders = [...holderScan.balances.entries()]
    .filter(([addr]) => addr.toLowerCase() !== poolAddress.toLowerCase())
    .sort((a, b) => (b[1] > a[1] ? 1 : -1));

  const top5 = sortedHolders.slice(0, 5).map(([address, balance]) => ({
    address,
    balance: balance.toString(),
    pct: totalSupply > 0n ? Number((balance * 10_000n) / totalSupply) / 100 : 0,
  }));

  const top5Balance = sortedHolders
    .slice(0, 5)
    .reduce((acc, [, bal]) => acc + bal, 0n);

  const top5HoldersPct: number | null = holderScan.failed
    ? null
    : totalSupply > 0n ? Number((top5Balance * 10_000n) / totalSupply) / 100 : 0;

  // ── 6. Pool liquidity ──────────────────────────────────────────────────────
  const poolLiquidityRaw = await safeReadNullable<bigint>(
    () => client.readContract({ address: poolAddress, abi: POOL_LIQUIDITY_ABI, functionName: "liquidity" }) as Promise<bigint>,
    "pool.liquidity",
    warnings
  );
  const liquidityLocked = poolLiquidityRaw === null ? null : poolLiquidityRaw > 0n;

  let initialLiquidityEth: number | null = null;
  if (poolLiquidityRaw !== null && poolLiquidityRaw > 0n) {
    try {
      const slot0 = await client.readContract({
        address: poolAddress,
        abi: POOL_SLOT0_ABI,
        functionName: "slot0",
      }) as readonly [bigint, ...unknown[]];
      const sqrtPriceX96 = slot0[0];
      if (sqrtPriceX96 > 0n) {
        const Q96 = 2n ** 96n;
        const raw = Number(formatEther((poolLiquidityRaw * Q96) / sqrtPriceX96));

        // Sanity bound: total ETH ever in existence is ~120M.
        // Values above this are a sqrtPriceX96 math artifact (near-zero price
        // → near-zero divisor → astronomically large quotient). Treat as invalid.
        const ETH_SUPPLY_MAX = 200_000_000; // 200M — generous headroom
        if (raw > ETH_SUPPLY_MAX) {
          warnings.push(
            `[pool.slot0] initialLiquidityEth computation yielded ${raw.toFixed(0)} ETH — ` +
            `physically impossible (total ETH supply ~120M). Likely a near-zero sqrtPriceX96 ` +
            `artifact. Value nulled; treat pool liquidity as unverified.`
          );
          initialLiquidityEth = null;
        } else {
          initialLiquidityEth = raw;
        }
      }
    } catch (err) {
      warn(warnings, "pool.slot0", "slot0 read failed", err);
    }
  }

  // ── 7. New checks: sell test, LP lock, burn history, source, deployer ────
  const sellTest = await testSellability(client, tokenAddress, poolAddress, top5, ownerAddress, deployer.address, warnings);
  const lpLock = await checkLpLockStatus(client, poolAddress, deployBlock, warnings);
  const pullHistory = await checkLiquidityPullHistory(
    client, poolAddress, deployBlock, holderScan.scanTo, warnings
  );
  const sourceCheck = await checkSourceVerification(tokenAddress, warnings, ownershipRenounced, ownerAddress);
  const deployerHistoryData = deployerHistory ?? { deployerSeenBefore: false, deployerPriorTokens: [] };

  // ── 8. Liquidity delta check (if state provided) ──────────────────────────
  let liquidityDeltaData: { liquidityDeltaPct: number | null; liquidityPreviousReading: string | null; snapshotAgeMinutes: number | null } = { liquidityDeltaPct: null, liquidityPreviousReading: null, snapshotAgeMinutes: null };
  if (state) {
    const deltaResult = await checkLiquidityDelta(client, poolAddress, state);
    liquidityDeltaData = {
      liquidityDeltaPct: deltaResult.liquidityDeltaPct,
      liquidityPreviousReading: deltaResult.liquidityPreviousReading,
      snapshotAgeMinutes: deltaResult.snapshotAgeMinutes,
    };
    // Save the current snapshot
    if (deltaResult.currentSnapshot) {
      recordLiquiditySnapshot(state, poolAddress, deltaResult.currentSnapshot);
      saveState(state);
    }
  }

  // ── 9. Trade activity scan (wash trading detection) ───────────────────────
  // Determine if the target token is token0 or token1 in the pool
  let token0IsTarget = false;
  try {
    const token0 = await client.readContract({
      address: poolAddress,
      abi: POOL_TOKENS_ABI,
      functionName: "token0",
    }) as string;
    token0IsTarget = token0.toLowerCase() === tokenAddress.toLowerCase();
  } catch (err) {
    warn(warnings, "tradeScan", "failed to read pool token0/token1", err);
  }

  const tradeActivity = await scanTradeActivity(
    client, 
    poolAddress, 
    deployBlock, 
    token0IsTarget, 
    warnings
  );

  const buySellRatio: number | null = tradeActivity.sellCount > 0 
    ? tradeActivity.buyCount / tradeActivity.sellCount 
    : null;

  const roundTripTraderPct: number | null = tradeActivity.uniqueTraders > 0
    ? (tradeActivity.roundTripTraders.length / tradeActivity.uniqueTraders) * 100
    : null;

  // ── 8. Assemble ────────────────────────────────────────────────────────────
  return {
    tokenAddress,
    poolAddress,
    pairedAsset,
    deployBlock: deployBlock.toString(),

    name,
    symbol,
    decimals,
    totalSupply: totalSupply.toString(),
    totalSupplyFormatted,

    ownerAddress,
    ownershipRenounced,
    isProxy,

    deployerAddress:        deployer.address,
    deployerMintBlock:      deployer.mintBlock?.toString() ?? null,
    deployerMintAmount:     deployer.mintAmount?.toString() ?? null,
    deployerCurrentBalance: deployerCurrentBalance?.toString() ?? null,
    deployerPct,

    holderScanFrom:    holderScan.scanFrom.toString(),
    holderScanTo:      holderScan.scanTo.toString(),
    holderScanPartial: holderScan.partial,
    holderScanFailed:  holderScan.failed,
    top5Holders:       top5,
    top5HoldersPct,

    poolLiquidity:       poolLiquidityRaw?.toString() ?? null,
    liquidityLocked,
    initialLiquidityEth,

    liquidityDeltaPct:      liquidityDeltaData.liquidityDeltaPct,
    liquidityPreviousReading: liquidityDeltaData.liquidityPreviousReading,
    snapshotAgeMinutes:     liquidityDeltaData.snapshotAgeMinutes,

    sellTestPassed:      sellTest.sellTestPassed,
    sellTestAmountSent:  sellTest.sellTestAmountSent,
    sellTestError:       sellTest.sellTestError,

    lpTokenId:           lpLock.lpTokenId,
    lpPositionOwner:     lpLock.lpPositionOwner,
    lpPositionStatus:    lpLock.lpPositionStatus,

    liquidityEverPulled: pullHistory.liquidityEverPulled,
    burnEventCount:      pullHistory.burnEventCount,

    sourceVerified:       sourceCheck.sourceVerified,
    suspiciousFunctions:  sourceCheck.suspiciousFunctions,
    secondaryAdminDetected: sourceCheck.secondaryAdminDetected,
    secondaryAdminSnippet: sourceCheck.secondaryAdminSnippet,

    deployerSeenBefore:   deployerHistoryData.deployerSeenBefore,
    deployerPriorTokens:  deployerHistoryData.deployerPriorTokens,

    totalSwaps:           tradeActivity.totalSwaps,
    uniqueTraders:        tradeActivity.uniqueTraders,
    buyCount:             tradeActivity.buyCount,
    sellCount:            tradeActivity.sellCount,
    buySellRatio:         buySellRatio,
    roundTripTraderCount: tradeActivity.roundTripTraders.length,
    roundTripTraderPct:   roundTripTraderPct,
    topTraderSwapSharePct: tradeActivity.topTraderSwapShare,
    tradeScanPartial:     tradeActivity.scanPartial,

    rpcWarnings: warnings,
  };
}
