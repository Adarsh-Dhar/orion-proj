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
 *   then walks FORWARD in SCAN_CHUNK windows rather than making
 *   one unbounded call. This eliminates the "range exceeds limit" error that
 *   broke every historical scan.
 *
 * V4 support:
 *   All pool-specific reads have a V4 branch that uses the singleton
 *   PoolManager / StateView contract rather than per-pool contract calls.
 *   poolAddress for V4 tokens is the bytes32 PoolId cast to Address — it is
 *   NOT a callable contract.  Every function that reads pool state must
 *   branch on `venue` before issuing any RPC call against poolAddress.
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
  // V4-specific
  UNISWAP_V4_POOL_MANAGER,
  UNISWAP_V4_STATE_VIEW,
  UNISWAP_V4_QUOTER,
  V4_STATE_VIEW_SLOT0_ABI,
  V4_STATE_VIEW_LIQUIDITY_ABI,
  V4_SWAP_EVENT_ABI,
  V4_MODIFY_LIQUIDITY_EVENT_ABI,
  V4_QUOTER_EXACT_INPUT_SINGLE_ABI,
  type Venue,
} from "./utils/constants.js";
import type { TokenEvidence, DeployerResult, HolderScanResult, TradeActivity, ReVerifyResult } from "./utils/interface.js";
import { analyzeSourceWithLLM } from "./agents/source-audit-agent.js";
import type { FunctionAudit, SourceAuditMethod } from "./agents/types.js";

// Re-export types that are used by other modules
export type { TokenEvidence, DeployerResult, HolderScanResult, TradeActivity, ReVerifyResult };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

/** Max blocks per eth_getLogs call.
 *  Alchemy free tier: 10 blocks. PAYG / Growth: raise to 500 or 2000. */
const SCAN_CHUNK   = 10n;
const MAX_LOOKBACK = 200_000n;

/**
 * Window used when searching for the initial LP-add event (Mint on V3,
 * ModifyLiquidity on V4).  On Base (~2 s/block) this is roughly 15–20 min,
 * which is wide enough to catch deployers who add liquidity well after pool
 * creation, while still being a bounded single getLogs call.
 *
 * NOTE: this exceeds Alchemy free-tier limits (10 blocks) so it makes
 * multiple chunked requests internally — see checkLpLockStatusV3/V4.
 */
const LP_LOCK_SCAN_WINDOW = 500n;
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



export async function findDeployer(
  client: AnyClient,
  tokenAddress: Address,
  deployBlock: bigint,
  warnings: string[]
): Promise<DeployerResult> {
  // Mint happens at or before the pool creation block.
  // Walk backwards in SCAN_CHUNK windows up to MAX_LOOKBACK blocks.
  // "Tight" pass = the first few chunks immediately around deployBlock;
  // "Wide" pass = the remaining history — same loop, different label.
  const hardFloor = deployBlock > MAX_LOOKBACK ? deployBlock - MAX_LOOKBACK : 0n;
  let chunkEnd = deployBlock;

  while (chunkEnd >= hardFloor) {
    const chunkStart = chunkEnd >= SCAN_CHUNK ? chunkEnd - (SCAN_CHUNK - 1n) : 0n;
    const clampedStart = chunkStart > hardFloor ? chunkStart : hardFloor;
    try {
      const logs = await client.getLogs({
        address: tokenAddress,
        event: TRANSFER_EVENT_ABI[0],
        args: { from: NULL_ADDRESS as Address },
        fromBlock: clampedStart,
        toBlock: chunkEnd,
      });
      if (logs.length > 0) {
        const sorted = [...logs].sort((a, b) => (a.blockNumber! < b.blockNumber! ? -1 : 1));
        const first  = sorted[0];
        const to     = (first.args as { to: string }).to ?? null;
        const value  = (first.args as { value?: bigint }).value ?? null;
        return {
          address: to,
          mintBlock: first.blockNumber ?? null,
          mintAmount: value,
          source: chunkEnd === deployBlock ? "tight" : "wide",
        };
      }
    } catch (err) {
      warn(warnings, "findDeployer", `chunk [${clampedStart}, ${chunkEnd}] failed`, err);
      // Stop — don't burn requests on a connection that's already failing
      return { address: null, mintBlock: null, mintAmount: null, source: "unknown" };
    }
    if (clampedStart <= hardFloor) break;
    chunkEnd = clampedStart - 1n;
  }

  return { address: null, mintBlock: null, mintAmount: null, source: "unknown" };
}

// ─── Holder balance scan ──────────────────────────────────────────────────────



/**
 * Fetch holder balances by scanning Transfer events from `fromBlock` to the
 * current chain head, walking forward in SCAN_CHUNK (10k) windows.
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
      // Stop — don't burn requests on a connection that's already failing
      break;
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
  state: BotState,
  venue: Venue = "v3"
): Promise<{
  liquidityDeltaPct: number | null;
  liquidityPreviousReading: string | null;
  snapshotAgeMinutes: number | null;
  currentSnapshot: LiquiditySnapshot;
}> {
  const history = state.liquidityHistory[poolIdOrAddress.toLowerCase()] ?? [];
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

  // Don't save state here — let the caller batch-save to avoid excessive writes
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

// ── 2. LP position lock/burn status ──────────────────────────────────────────
//
// V3: watch for Mint events on the pool contract, check whether the NFT
// position manager minted an NFT, then check who owns that NFT.
//
// V4: there is no per-pool contract and no separate NFT position manager.
// Liquidity is managed directly through PoolManager via ModifyLiquidity
// events. We scan for the first positive-liquidityDelta ModifyLiquidity event
// on PoolManager filtered by poolId to identify who added the initial LP, and
// whether they later removed it (negative delta after the initial add).

export async function checkLpLockStatus(
  client: AnyClient,
  poolIdOrAddress: Address,
  deployBlock: bigint,
  warnings: string[],
  venue: Venue = "v3"
): Promise<{ lpTokenId: string | null; lpPositionOwner: string | null; lpPositionStatus: TokenEvidence["lpPositionStatus"] }> {
  if (venue === "v4") {
    return checkLpLockStatusV4(client, poolIdOrAddress, deployBlock, warnings);
  }
  return checkLpLockStatusV3(client, poolIdOrAddress, deployBlock, warnings);
}

async function checkLpLockStatusV3(
  client: AnyClient,
  poolAddress: Address,
  deployBlock: bigint,
  warnings: string[]
): Promise<{ lpTokenId: string | null; lpPositionOwner: string | null; lpPositionStatus: TokenEvidence["lpPositionStatus"] }> {
  try {
    // Scan LP_LOCK_SCAN_WINDOW blocks in SCAN_CHUNK-sized requests (Alchemy free
    // tier only allows 10 blocks per getLogs call).  We stop at the first Mint
    // event rather than scanning the whole window every time.
    const scanEnd = deployBlock + LP_LOCK_SCAN_WINDOW - 1n;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mintLog: any | undefined;

    for (
      let chunkStart = deployBlock;
      chunkStart <= scanEnd && !mintLog;
      chunkStart += SCAN_CHUNK
    ) {
      const chunkEnd = chunkStart + SCAN_CHUNK - 1n < scanEnd
        ? chunkStart + SCAN_CHUNK - 1n
        : scanEnd;
      try {
        const logs = await client.getLogs({
          address: poolAddress,
          event: POOL_MINT_EVENT_ABI[0],
          fromBlock: chunkStart,
          toBlock: chunkEnd,
        });
        if (logs.length > 0) mintLog = logs[0];
      } catch (err) {
        warn(warnings, "lpLock", `V3 Mint scan chunk [${chunkStart}, ${chunkEnd}] failed`, err);
        break;
      }
    }

    if (!mintLog) {
      return { lpTokenId: null, lpPositionOwner: null, lpPositionStatus: "unverified" };
    }
    const mintOwner = (mintLog.args as { owner: string }).owner;

    if (mintOwner.toLowerCase() !== UNISWAP_V3_POSITION_MANAGER.toLowerCase()) {
      // Liquidity added directly — no position NFT; that address controls it.
      return { lpTokenId: null, lpPositionOwner: mintOwner, lpPositionStatus: "non_nft_position" };
    }

    const receipt     = await client.getTransactionReceipt({ hash: mintLog.transactionHash! });
    const increaseLogs = parseEventLogs({ abi: NPM_INCREASE_LIQUIDITY_EVENT_ABI, logs: receipt.logs });
    const npmLog       = increaseLogs.find(
      (l) => l.address.toLowerCase() === UNISWAP_V3_POSITION_MANAGER.toLowerCase()
    );

    if (!npmLog) {
      return { lpTokenId: null, lpPositionOwner: mintOwner, lpPositionStatus: "unverified" };
    }

    const tokenId = (npmLog.args as { tokenId: bigint }).tokenId;
    const owner   = (await client.readContract({
      address: UNISWAP_V3_POSITION_MANAGER,
      abi:     NPM_OWNER_OF_ABI,
      functionName: "ownerOf",
      args: [tokenId],
    })) as string;

    let status: TokenEvidence["lpPositionStatus"];
    if (owner.toLowerCase() === BURN_ADDRESS.toLowerCase())    status = "burned";
    else if (owner.toLowerCase() === UNCX_V3_LOCKER.toLowerCase()) status = "locked_uncx";
    else                                                           status = "held_by_eoa";

    return { lpTokenId: tokenId.toString(), lpPositionOwner: owner, lpPositionStatus: status };
  } catch (err) {
    warn(warnings, "lpLock", "V3 position lookup failed", err);
    return { lpTokenId: null, lpPositionOwner: null, lpPositionStatus: "unverified" };
  }
}

async function checkLpLockStatusV4(
  client: AnyClient,
  poolId: Address,
  deployBlock: bigint,
  warnings: string[]
): Promise<{ lpTokenId: string | null; lpPositionOwner: string | null; lpPositionStatus: TokenEvidence["lpPositionStatus"] }> {
  // Scan ModifyLiquidity events on the PoolManager filtered by this pool's id.
  // We look within a generous window (deploy block + 500) to catch the initial
  // liquidity add, then check whether the same sender later pulled it.
  try {
    // Scan up to LP_LOCK_SCAN_WINDOW blocks in SCAN_CHUNK-sized chunks for the
    // initial ModifyLiquidity add event.  Stop at first positive-delta match.
    const scanEnd = deployBlock + LP_LOCK_SCAN_WINDOW - 1n;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let firstAdd: any | undefined;
    const poolIdLower = poolId.toLowerCase();

    for (
      let chunkStart = deployBlock;
      chunkStart <= scanEnd && !firstAdd;
      chunkStart += SCAN_CHUNK
    ) {
      const chunkEnd = chunkStart + SCAN_CHUNK - 1n < scanEnd
        ? chunkStart + SCAN_CHUNK - 1n
        : scanEnd;
      try {
        const addLogs = await client.getLogs({
          address: UNISWAP_V4_POOL_MANAGER as Address,
          event:   V4_MODIFY_LIQUIDITY_EVENT_ABI[0],
          fromBlock: chunkStart,
          toBlock:   chunkEnd,
        });
        const poolAddLogs = (addLogs as unknown[]).filter(
          (l: unknown) => ((l as { args: { id: string } }).args?.id?.toLowerCase() === poolIdLower)
        );
        firstAdd = (poolAddLogs as unknown[]).find(
          (l: unknown) => ((l as { args: { liquidityDelta: bigint } }).args?.liquidityDelta ?? 0n) > 0n
        );
      } catch (err) {
        warn(warnings, "lpLock", `V4 add-scan chunk [${chunkStart}, ${chunkEnd}] failed`, err);
        break;
      }
    }
    if (!firstAdd) {
      return { lpTokenId: null, lpPositionOwner: null, lpPositionStatus: "unverified" };
    }

    const lpSender = (firstAdd.args as { sender: string }).sender;

    // Now check from firstAdd block to latest for any negative-delta event
    // from the same sender — that would mean they later pulled liquidity.
    const latestBlock = await client.getBlockNumber();
    let removedByLpOwner = false;

    for (
      let chunkStart = (firstAdd.blockNumber ?? deployBlock) + 1n;
      chunkStart <= latestBlock;
      chunkStart += SCAN_CHUNK
    ) {
      const chunkEnd = chunkStart + SCAN_CHUNK - 1n < latestBlock
        ? chunkStart + SCAN_CHUNK - 1n
        : latestBlock;
      try {
        const removeLogs = await client.getLogs({
          address: UNISWAP_V4_POOL_MANAGER as Address,
          event:   V4_MODIFY_LIQUIDITY_EVENT_ABI[0],
          // Filter only by sender (address topic — works on free tier).
          // poolId (bytes32 topic) filtered client-side.
          args:    { sender: lpSender as Address },
          fromBlock: chunkStart,
          toBlock:   chunkEnd,
        });
        for (const l of removeLogs) {
          const args = l.args as { id: string; liquidityDelta: bigint };
          if (args.id?.toLowerCase() !== poolIdLower) continue;
          if (args.liquidityDelta < 0n) {
            removedByLpOwner = true;
            break;
          }
        }
      } catch (err) {
        warn(warnings, "lpLock", `V4 remove-scan chunk [${chunkStart}, ${chunkEnd}] failed`, err);
      }
      if (removedByLpOwner) break;
    }

    // V4 has no NFT-based locker; we report the sender as owner.
    // If they haven't pulled, classify as "non_nft_position" (direct control).
    // If they have already pulled, classify as "held_by_eoa" (unprotected and drained).
    const status: TokenEvidence["lpPositionStatus"] = removedByLpOwner
      ? "held_by_eoa"
      : "non_nft_position";

    return { lpTokenId: null, lpPositionOwner: lpSender, lpPositionStatus: status };
  } catch (err) {
    warn(warnings, "lpLock", "V4 position lookup failed", err);
    return { lpTokenId: null, lpPositionOwner: null, lpPositionStatus: "unverified" };
  }
}

// ── 3. Liquidity pull history ─────────────────────────────────────────────────
//
// V3: scan Burn events on the pool contract.
// V4: scan ModifyLiquidity events with negative liquidityDelta on PoolManager,
//     filtered by poolId.

export async function checkLiquidityPullHistory(
  client: AnyClient,
  poolIdOrAddress: Address,
  deployBlock: bigint,
  currentBlock: bigint,
  warnings: string[],
  venue: Venue = "v3"
): Promise<{ liquidityEverPulled: boolean; burnEventCount: number }> {
  if (venue === "v4") {
    return checkLiquidityPullHistoryV4(client, poolIdOrAddress, deployBlock, currentBlock, warnings);
  }
  return checkLiquidityPullHistoryV3(client, poolIdOrAddress, deployBlock, currentBlock, warnings);
}

async function checkLiquidityPullHistoryV3(
  client: AnyClient,
  poolAddress: Address,
  deployBlock: bigint,
  currentBlock: bigint,
  warnings: string[]
): Promise<{ liquidityEverPulled: boolean; burnEventCount: number }> {
  let count = 0;
  for (
    let chunkStart = deployBlock;
    chunkStart <= currentBlock;
    chunkStart += SCAN_CHUNK
  ) {
    const chunkEnd = chunkStart + SCAN_CHUNK - 1n < currentBlock
      ? chunkStart + SCAN_CHUNK - 1n
      : currentBlock;
    try {
      const logs = await client.getLogs({
        address: poolAddress,
        event:   POOL_BURN_EVENT_ABI[0],
        fromBlock: chunkStart,
        toBlock:   chunkEnd,
      });
      count += logs.length;
    } catch (err) {
      warn(warnings, "burnHistory", `V3 chunk [${chunkStart}, ${chunkEnd}] failed`, err);
      break; // Stop — don't burn requests on a failing connection
    }
  }
  return { liquidityEverPulled: count > 0, burnEventCount: count };
}

async function checkLiquidityPullHistoryV4(
  client: AnyClient,
  poolId: Address,
  deployBlock: bigint,
  currentBlock: bigint,
  warnings: string[]
): Promise<{ liquidityEverPulled: boolean; burnEventCount: number }> {
  // Count ModifyLiquidity events with negative liquidityDelta — these are
  // partial or full liquidity removals on a V4 pool.
  let count = 0;
  for (
    let chunkStart = deployBlock;
    chunkStart <= currentBlock;
    chunkStart += SCAN_CHUNK
  ) {
    const chunkEnd = chunkStart + SCAN_CHUNK - 1n < currentBlock
      ? chunkStart + SCAN_CHUNK - 1n
      : currentBlock;
    try {
      const logs = await client.getLogs({
        address: UNISWAP_V4_POOL_MANAGER as Address,
        event:   V4_MODIFY_LIQUIDITY_EVENT_ABI[0],
        // No bytes32 args filter — rejected by Alchemy free tier.
        // Filter by poolId client-side.
        fromBlock: chunkStart,
        toBlock:   chunkEnd,
      });
      const poolIdLower = poolId.toLowerCase();
      for (const l of logs) {
        const args = l.args as { id: string; liquidityDelta: bigint };
        if (args.id?.toLowerCase() !== poolIdLower) continue;
        if (args.liquidityDelta < 0n) {
          count++;
        }
      }
    } catch (err) {
      warn(warnings, "burnHistory", `V4 chunk [${chunkStart}, ${chunkEnd}] failed`, err);
      break; // Stop — don't burn requests on a failing connection
    }
  }
  return { liquidityEverPulled: count > 0, burnEventCount: count };
}

// ── Trade activity scan (wash trading detection) ──────────────────────────────
//
// V3: scan Swap events on the pool contract.
// V4: scan Swap events on the PoolManager filtered by the poolId (id field).



export async function scanTradeActivity(
  client: AnyClient,
  poolIdOrAddress: Address,
  fromBlock: bigint,
  token0IsTarget: boolean,
  warnings: string[],
  venue: Venue = "v3"
): Promise<TradeActivity> {
  if (venue === "v4") {
    return scanTradeActivityV4(client, poolIdOrAddress, fromBlock, token0IsTarget, warnings);
  }
  return scanTradeActivityV3(client, poolIdOrAddress, fromBlock, token0IsTarget, warnings);
}

async function scanTradeActivityV3(
  client: AnyClient,
  poolAddress: Address,
  fromBlock: bigint,
  token0IsTarget: boolean,
  warnings: string[]
): Promise<TradeActivity> {
  const latestBlock    = await client.getBlockNumber();
  const swapsByAddress = new Map<string, { buys: number; sells: number }>();
  let chunksFailed = 0, chunksTotal = 0, totalSwaps = 0;

  for (let chunkStart = fromBlock; chunkStart <= latestBlock; chunkStart += SCAN_CHUNK) {
    const chunkEnd = chunkStart + SCAN_CHUNK - 1n < latestBlock
      ? chunkStart + SCAN_CHUNK - 1n
      : latestBlock;
    chunksTotal++;
    try {
      const logs = await client.getLogs({
        address: poolAddress,
        event:   POOL_SWAP_EVENT_ABI[0],
        fromBlock: chunkStart,
        toBlock:   chunkEnd,
      });
      for (const log of logs) {
        const { recipient, amount0, amount1 } = log.args as {
          recipient: string; amount0: bigint; amount1: bigint;
        };
        totalSwaps++;
        const targetAmount = token0IsTarget ? amount0 : amount1;
        const isBuy = targetAmount < 0n;
        const entry = swapsByAddress.get(recipient) ?? { buys: 0, sells: 0 };
        if (isBuy) entry.buys++; else entry.sells++;
        swapsByAddress.set(recipient, entry);
      }
    } catch (err) {
      chunksFailed++;
      warn(warnings, "tradeScan", `V3 chunk [${chunkStart}, ${chunkEnd}] failed`, err);
      break; // Stop — don't burn requests on a failing connection
    }
  }

  return buildTradeActivity(swapsByAddress, totalSwaps, chunksFailed > 0);
}

async function scanTradeActivityV4(
  client: AnyClient,
  poolId: Address,
  fromBlock: bigint,
  token0IsTarget: boolean,
  warnings: string[]
): Promise<TradeActivity> {
  // V4 Swap events are emitted on the PoolManager contract.  The `id` field
  // (indexed) carries the PoolId, so we can filter precisely.
  const latestBlock    = await client.getBlockNumber();
  const swapsByAddress = new Map<string, { buys: number; sells: number }>();
  let chunksFailed = 0, chunksTotal = 0, totalSwaps = 0;

  for (let chunkStart = fromBlock; chunkStart <= latestBlock; chunkStart += SCAN_CHUNK) {
    const chunkEnd = chunkStart + SCAN_CHUNK - 1n < latestBlock
      ? chunkStart + SCAN_CHUNK - 1n
      : latestBlock;
    chunksTotal++;
    try {
      const logs = await client.getLogs({
        address: UNISWAP_V4_POOL_MANAGER as Address,
        event:   V4_SWAP_EVENT_ABI[0],
        // No bytes32 args filter — rejected by Alchemy free tier.
        // Filter by poolId client-side.
        fromBlock: chunkStart,
        toBlock:   chunkEnd,
      });
      const poolIdLower = poolId.toLowerCase();
      for (const log of logs) {
        const args = log.args as { id: string; recipient: string; amount0: bigint; amount1: bigint };
        if (args.id?.toLowerCase() !== poolIdLower) continue;
        const { recipient, amount0, amount1 } = args;
        totalSwaps++;
        // Negative amount on the target side = pool sent that token to trader = buy
        const targetAmount = token0IsTarget ? amount0 : amount1;
        const isBuy = targetAmount < 0n;
        const entry = swapsByAddress.get(recipient) ?? { buys: 0, sells: 0 };
        if (isBuy) entry.buys++; else entry.sells++;
        swapsByAddress.set(recipient, entry);
      }
    } catch (err) {
      chunksFailed++;
      warn(warnings, "tradeScan", `V4 chunk [${chunkStart}, ${chunkEnd}] failed`, err);
      break; // Stop — don't burn requests on a failing connection
    }
  }

  return buildTradeActivity(swapsByAddress, totalSwaps, chunksFailed > 0);
}

function buildTradeActivity(
  swapsByAddress: Map<string, { buys: number; sells: number }>,
  totalSwaps: number,
  anyChunkFailed: boolean
): TradeActivity {
  const buyerAddresses  = new Set<string>();
  const sellerAddresses = new Set<string>();
  const roundTripTraders: string[] = [];
  let buyCount = 0, sellCount = 0, maxSwapsForOne = 0;

  for (const [addr, { buys, sells }] of swapsByAddress) {
    buyCount  += buys;
    sellCount += sells;
    if (buys  > 0) buyerAddresses.add(addr);
    if (sells > 0) sellerAddresses.add(addr);
    if (buys  > 0 && sells > 0) roundTripTraders.push(addr);
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
    scanPartial: anyChunkFailed,
  };
}

// ── 4. Source verification — fetch + LLM rubric audit ─────────────────────────
// Keyword-grep replaced by analyzeSourceWithLLM() (src/lib/agents/source-audit-agent.ts).
// This function now only does the Etherscan fetch; all judgment (suspicious
// function detection, secondary-admin detection) happens in the agent, which
// falls back to a keyword heuristic internally if the LLM call fails.
export async function checkSourceVerification(
  tokenAddress: Address,
  warnings: string[],
  ownershipRenounced: boolean | null,
  ownerAddress: string | null
): Promise<{
  sourceVerified: boolean | null;
  suspiciousFunctions: { name: string; snippet: string }[];
  secondaryAdminDetected: boolean;
  secondaryAdminSnippet: string | null;
  sourceAuditMethod: SourceAuditMethod | null;
  functionAudits: FunctionAudit[];
}> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    warn(warnings, "sourceCheck", "ETHERSCAN_API_KEY not set — skipping", "missing env var");
    return {
      sourceVerified: null, suspiciousFunctions: [], secondaryAdminDetected: false,
      secondaryAdminSnippet: null, sourceAuditMethod: null, functionAudits: [],
    };
  }

  let source = "";
  try {
    const url  = `${ETHERSCAN_API_BASE}?chainid=${BASE_CHAIN_ID}&module=contract&action=getsourcecode&address=${tokenAddress}&apikey=${apiKey}`;
    const res  = await fetch(url);
    const json = await res.json();
    source = json?.result?.[0]?.SourceCode ?? "";
  } catch (err) {
    warn(warnings, "sourceCheck", "Etherscan API call failed", err);
    return {
      sourceVerified: null, suspiciousFunctions: [], secondaryAdminDetected: false,
      secondaryAdminSnippet: null, sourceAuditMethod: null, functionAudits: [],
    };
  }

  if (!source) {
    return {
      sourceVerified: false, suspiciousFunctions: [], secondaryAdminDetected: false,
      secondaryAdminSnippet: null, sourceAuditMethod: null, functionAudits: [],
    };
  }

  const audit = await analyzeSourceWithLLM(source, ownershipRenounced, ownerAddress, warnings);
  return {
    sourceVerified: true,
    suspiciousFunctions: audit.suspiciousFunctions,
    secondaryAdminDetected: audit.secondaryAdminDetected,
    secondaryAdminSnippet: audit.secondaryAdminSnippet,
    sourceAuditMethod: audit.method,
    functionAudits: audit.functionAudits,
  };
}


// ─── Main collection function ─────────────────────────────────────────────────

export async function collectEvidence(
  client: AnyClient,
  tokenAddress: Address,
  /** V3: pool contract address. V4: bytes32 PoolId hex-encoded as Address. */
  poolAddress: Address,
  pairedAsset: string,
  deployBlock: bigint,
  meta: { name: string; symbol: string; decimals: number; totalSupply: bigint; totalSupplyFormatted: string },
  deployerHistory?: { deployerSeenBefore: boolean; deployerPriorTokens: string[] },
  state?: BotState,
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
  },
  /** Skip expensive checks for faster analysis */
  quickMode?: boolean,
  /** Use efficient sniper-style analysis (recent blocks only) */
  sniperMode?: boolean
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

  // ── 4. Deployer (mint event scan) ─────────────────────────────────────────
  const deployer = await findDeployer(client, tokenAddress, deployBlock, warnings);

  // ── 5. Holder balances ─────────────────────────────────────────────────────
  let holderScan: HolderScanResult;
  let holderScanFrom: bigint;

  // Determine scan range based on mode
  if (sniperMode) {
    // In sniper mode, only scan recent blocks (like the sniper does)
    const latestBlock = await client.getBlockNumber();
    holderScanFrom = latestBlock > SCAN_CHUNK ? latestBlock - SCAN_CHUNK : 0n;
    console.log(`[evidence] Sniper mode: scanning recent blocks from ${holderScanFrom}`);
  } else if (quickMode) {
    console.log("[evidence] Quick mode: skipping holder balance scan");
    holderScanFrom = deployBlock;
  } else {
    holderScanFrom = deployer.mintBlock !== null
      ? deployer.mintBlock
      : deployBlock > SCAN_CHUNK ? deployBlock - SCAN_CHUNK : 0n;
  }

  if (quickMode) {
    holderScan = { balances: new Map(), partial: true, failed: false, scanFrom: holderScanFrom, scanTo: holderScanFrom };
    warnings.push("[holderScan] Skipped in quick mode");
  } else {
    holderScan = await scanHolderBalances(client, tokenAddress, holderScanFrom, warnings);
  }

  let deployerCurrentBalance: bigint | null = null;
  if (!holderScan.failed && deployer.address) {
    deployerCurrentBalance = holderScan.balances.get(deployer.address.toLowerCase()) ?? 0n;
  }

  if (
    deployer.source === "wide" &&
    deployer.mintBlock !== null &&
    deployer.mintBlock < holderScanFrom &&
    deployerCurrentBalance === 0n &&
    deployer.mintAmount !== null
  ) {
    deployerCurrentBalance = deployer.mintAmount;
    warnings.push("[holderScan] deployer balance is a floor estimate — mint predates scan window");
  }

  // (deployerPct computed below with the top-5 rebase guard)

  // Top-5 holders (excluding the pool address itself)
  const sortedHolders = [...holderScan.balances.entries()]
    .filter(([addr]) => addr.toLowerCase() !== poolAddress.toLowerCase())
    .sort((a, b) => (b[1] > a[1] ? 1 : -1));

  // Rebase / elastic-supply detection: if any reconstructed balance implies
  // a share > 100% of the current totalSupply(), our Transfer-delta accounting
  // is stale (supply shrank without emitting Transfer events).  Cap at 100 and
  // flag it so the LLM treats the distribution as unreliable.
  let rebaseSuspected = false;

  const top5 = sortedHolders.slice(0, 5).map(([address, balance]) => {
    const rawPct = totalSupply > 0n ? Number((balance * 10_000n) / totalSupply) / 100 : 0;
    if (rawPct > 100) rebaseSuspected = true;
    return { address, balance: balance.toString(), pct: Math.min(rawPct, 100) };
  });

  const top5Balance = sortedHolders.slice(0, 5).reduce((acc, [, bal]) => acc + bal, 0n);
  const rawTop5Pct = totalSupply > 0n
    ? Number((top5Balance * 10_000n) / totalSupply) / 100
    : 0;
  if (rawTop5Pct > 100) rebaseSuspected = true;

  const top5HoldersPct: number | null = holderScan.failed
    ? null
    : Math.min(rawTop5Pct, 100);

  // Clamp deployer pct too — same stale-balance issue applies
  const deployerPctRaw: number | null =
    deployer.address && totalSupply > 0n && deployerCurrentBalance !== null
      ? Number((deployerCurrentBalance * 10_000n) / totalSupply) / 100
      : null;
  const deployerPct: number | null =
    deployerPctRaw !== null ? Math.min(deployerPctRaw, 100) : null;
  if (deployerPctRaw !== null && deployerPctRaw > 100) rebaseSuspected = true;

  if (rebaseSuspected) {
    warnings.push(
      "[holderScan] reconstructed holder balances exceed totalSupply() — likely a rebase/" +
      "elastic-supply token whose supply contractions do not emit Transfer events. " +
      "Holder percentages are unreliable and have been capped at 100%."
    );
  }

  // ── 6. Pool liquidity + initial ETH value ─────────────────────────────────
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
        }
      } catch (err) {
        warn(warnings, "pool.slot0", "slot0 read failed", err);
      }
    }
  }

  // ── 7. Sell test, LP lock, burn history ───────────────────────────────────
  const sellTest   = await testSellability(
    client, tokenAddress, poolAddress, top5, ownerAddress, deployer.address,
    warnings, resolvedVenue, v4PoolParams, poolLiquidityRaw   // poolLiquidityRaw gates empty-pool guard
  );
  const lpLock     = await checkLpLockStatus(
    client, poolAddress, deployBlock, warnings, resolvedVenue
  );
  const pullHistory = await checkLiquidityPullHistory(
    client, poolAddress, deployBlock, holderScan.scanTo, warnings, resolvedVenue
  );
  const sourceCheck = await checkSourceVerification(
    tokenAddress, warnings, ownershipRenounced, ownerAddress
  );
  const deployerHistoryData = deployerHistory ?? { deployerSeenBefore: false, deployerPriorTokens: [] };

  // ── 8. Liquidity delta check (if state provided) ──────────────────────────
  let liquidityDeltaData: {
    liquidityDeltaPct: number | null;
    liquidityPreviousReading: string | null;
    snapshotAgeMinutes: number | null;
  } = { liquidityDeltaPct: null, liquidityPreviousReading: null, snapshotAgeMinutes: null };

  if (state) {
    try {
      const deltaResult = await checkLiquidityDelta(client, poolAddress, state, resolvedVenue);
      liquidityDeltaData = {
        liquidityDeltaPct:        deltaResult.liquidityDeltaPct,
        liquidityPreviousReading: deltaResult.liquidityPreviousReading,
        snapshotAgeMinutes:       deltaResult.snapshotAgeMinutes,
      };
      if (deltaResult.currentSnapshot) {
        recordLiquiditySnapshot(state, poolAddress, deltaResult.currentSnapshot);
        saveState(state);
      }
    } catch (err) {
      warn(warnings, "liquidityDelta", "checkLiquidityDelta failed", err);
    }
  }

  // ── 9. Trade activity scan (wash trading detection) ───────────────────────
  // For V3, determine token0/token1 order via the pool contract.
  // For V4, the order is already known from the Initialize event (currency0/currency1).
  let token0IsTarget = false;

  if (resolvedVenue === "v4" && v4PoolParams) {
    token0IsTarget = tokenAddress.toLowerCase() === v4PoolParams.currency0.toLowerCase();
  } else if (resolvedVenue === "v3") {
    try {
      const token0 = await client.readContract({
        address: poolAddress,
        abi:     POOL_TOKENS_ABI,
        functionName: "token0",
      }) as string;
      token0IsTarget = token0.toLowerCase() === tokenAddress.toLowerCase();
    } catch (err) {
      warn(warnings, "tradeScan", "failed to read pool token0/token1", err);
    }
  }

  const tradeActivity = quickMode
    ? { totalSwaps: 0, uniqueTraders: 0, buyCount: 0, sellCount: 0, roundTripTraders: [], topTraderSwapShare: 0, scanPartial: true }
    : sniperMode
      ? await scanTradeActivity(client, poolAddress, holderScanFrom, token0IsTarget, warnings, resolvedVenue)
      : await scanTradeActivity(client, poolAddress, deployBlock, token0IsTarget, warnings, resolvedVenue);

  if (quickMode) {
    warnings.push("[tradeScan] Skipped in quick mode");
  } else if (sniperMode) {
    console.log(`[evidence] Sniper mode: trade scan limited to recent blocks from ${holderScanFrom}`);
  }

  const buySellRatio: number | null = tradeActivity.sellCount > 0
    ? tradeActivity.buyCount / tradeActivity.sellCount
    : null;

  const roundTripTraderPct: number | null = tradeActivity.uniqueTraders > 0
    ? (tradeActivity.roundTripTraders.length / tradeActivity.uniqueTraders) * 100
    : null;

  // ── 10. Assemble ──────────────────────────────────────────────────────────
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

    liquidityDeltaPct:        liquidityDeltaData.liquidityDeltaPct,
    liquidityPreviousReading: liquidityDeltaData.liquidityPreviousReading,
    snapshotAgeMinutes:       liquidityDeltaData.snapshotAgeMinutes,

    sellTestPassed:     sellTest.sellTestPassed,
    sellTestAmountSent: sellTest.sellTestAmountSent,
    sellTestError:      sellTest.sellTestError,

    lpTokenId:        lpLock.lpTokenId,
    lpPositionOwner:  lpLock.lpPositionOwner,
    lpPositionStatus: lpLock.lpPositionStatus,

    liquidityEverPulled: pullHistory.liquidityEverPulled,
    burnEventCount:      pullHistory.burnEventCount,

    sourceVerified:          sourceCheck.sourceVerified,
    suspiciousFunctions:     sourceCheck.suspiciousFunctions,
    secondaryAdminDetected:  sourceCheck.secondaryAdminDetected,
    secondaryAdminSnippet:   sourceCheck.secondaryAdminSnippet,
    sourceAuditMethod:       sourceCheck.sourceAuditMethod,
    sourceFunctionAudits:    sourceCheck.functionAudits,

    deployerSeenBefore:  deployerHistoryData.deployerSeenBefore,
    deployerPriorTokens: deployerHistoryData.deployerPriorTokens,

    totalSwaps:           tradeActivity.totalSwaps,
    uniqueTraders:        tradeActivity.uniqueTraders,
    buyCount:             tradeActivity.buyCount,
    sellCount:            tradeActivity.sellCount,
    buySellRatio,
    roundTripTraderCount: tradeActivity.roundTripTraders.length,
    roundTripTraderPct,
    topTraderSwapSharePct: tradeActivity.topTraderSwapShare,
    tradeScanPartial:     tradeActivity.scanPartial,

    rpcWarnings: warnings,
  };
}

// ─── Re-verification pass ─────────────────────────────────────────────────────

/**
 * Fields that the re-verification pass can improve.
 * Returned by reVerifyEvidence(); caller decides which to apply.
 */

/**
 * Lightweight re-check that only re-runs the two fields most likely to be
 * wrong on a first-pass analysis run too close to pool creation:
 *
 *   1. LP lock status — was "unverified" because the Mint/ModifyLiquidity
 *      event hadn't landed yet.  Now re-scanned with a fresh block window.
 *
 *   2. Pool liquidity / initialLiquidityEth — was 0 / null because the
 *      LP-add tx hadn't been mined yet at evidence-collection time.
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

  // ── 1. Re-check LP lock status if the first pass came back "unverified" ──
  if (original.lpPositionStatus === "unverified") {
    try {
      const lpLock = await checkLpLockStatus(
        client, poolAddress, deployBlock, warnings, venue
      );
      if (lpLock.lpPositionStatus !== "unverified") {
        result.lpPositionStatus = lpLock.lpPositionStatus;
        result.lpTokenId        = lpLock.lpTokenId;
        result.lpPositionOwner  = lpLock.lpPositionOwner;
        result.improved = true;
        console.log(
          `  [reverify] LP lock upgraded: unverified → ${lpLock.lpPositionStatus}` +
          (lpLock.lpPositionOwner ? ` (owner: ${lpLock.lpPositionOwner})` : "")
        );
      } else {
        console.log(`  [reverify] LP lock still unverified — no Mint/ModifyLiquidity found yet`);
      }
    } catch (err) {
      warn(warnings, "reverify:lpLock", "LP lock re-check failed", err);
    }
  }

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