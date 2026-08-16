import {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type PublicClient,
  type Address,
  formatEther,
} from "viem";

// Internal alias so every helper accepts a chain-typed client without
// repeating the `any` annotation — the chain generic doesn't matter for
// any of the read operations we perform here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;
import {
  OWNER_ABI,
  NULL_ADDRESS,
  EIP1967_IMPL_SLOT,
  POOL_SLOT0_ABI,
  POOL_LIQUIDITY_ABI,
  TRANSFER_EVENT_ABI,
  ERC20_ABI,
} from "./constants.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface RiskFlag {
  id: string;               // machine-readable key
  label: string;            // short human label
  detail: string;           // evidence sentence shown in the report
  severity: RiskLevel;
  points: number;           // contribution to total risk score
}

export interface RugCheckResult {
  tokenAddress: Address;
  poolAddress: Address;
  pairedAsset: string;

  // ── Ownership ──────────────────────────────────────────────────────────────
  ownerAddress: string;
  ownershipRenounced: boolean;
  isProxy: boolean | null;    // null = could not verify (storage read failed)

  // ── Supply / dev wallet ────────────────────────────────────────────────────
  totalSupply: bigint;
  decimals: number;
  deployerAddress: string;
  deployerBalance: bigint;
  deployerBalanceIsEstimate: boolean; // true if balance is mint-amount only (see note below)
  deployerPct: number | null;   // null = unverified (not "0%")
  top5HoldersPct: number | null; // null = unverified (not "0%")

  // ── Liquidity ──────────────────────────────────────────────────────────────
  poolLiquidity: bigint | null;   // null = read failed; 0n = confirmed empty
  initialLiquidityEth: number;
  liquidityLocked: boolean | null; // null = unknown (read failed)

  // ── Scoring ────────────────────────────────────────────────────────────────
  flags: RiskFlag[];
  score: number;              // 0 (safe) → 100 (certain rug)
  verdict: RiskLevel;
  summary: string;            // one-line human verdict
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Score thresholds */
const VERDICT_THRESHOLDS: Record<RiskLevel, number> = {
  LOW: 0,
  MEDIUM: 25,
  HIGH: 50,
  CRITICAL: 75,
};

/** Minimum "healthy" initial liquidity in ETH-equivalent */
const MIN_LIQUIDITY_ETH = 0.5;

/** Dev wallet concentration thresholds */
const DEV_PCT_HIGH = 20;      // >20% = HIGH risk
const DEV_PCT_CRITICAL = 50;  // >50% = CRITICAL risk

/** Top-5 holder concentration threshold */
const TOP5_PCT_HIGH = 60;

/** Chunk size for backwards Transfer-log scans (stays under provider range limits) */
const SCAN_CHUNK = 10_000n;

/** How far back we're willing to walk looking for a mint event (~4 days on Base) */
const MAX_LOOKBACK = 200_000n;

const ZERO_SLOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Every RPC failure in this file is logged through this one function so
 * failures are visible in stdout instead of silently vanishing into a
 * fallback value. Without this, "confirmed safe" and "couldn't check" are
 * indistinguishable in the printed report — which is the worst failure mode
 * for a risk-scoring tool specifically, since a swallowed error reads as
 * a clean/reassuring result.
 */
function logRpcFailure(tag: string, context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`  [rugcheck:${tag}] ${context}: ${message}`);
}

/** Read a contract value, logging and falling back on failure. Only use this
 *  for fields where a fallback value is genuinely safe to treat as real data
 *  (e.g. decimals defaulting to 18). For anything the scorer treats as a
 *  pass/fail signal (liquidity, proxy status), use a nullable variant instead
 *  so "failed" can never be silently read as "confirmed clean." */
async function safeRead<T>(fn: () => Promise<T>, fallback: T, tag: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logRpcFailure(tag, "read failed, using fallback", err);
    return fallback;
  }
}

/** Same as safeRead, but returns null on failure instead of a fallback value,
 *  so callers can tell "confirmed X" apart from "couldn't check." */
async function safeReadNullable<T>(fn: () => Promise<T>, tag: string): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logRpcFailure(tag, "read failed", err);
    return null;
  }
}

interface DeployerResult {
  address: string;
  /** Block the mint Transfer was found in, or null if never found. */
  mintBlock: bigint | null;
  /** Which pass found it — used to decide if the holder-scan window covers it. */
  source: "tight" | "wide" | "unknown";
}

/**
 * Resolve the deployer address from the token's first mint (Transfer from 0x0).
 *
 * Strategy:
 * 1. Try a tight window around deployBlock (pool creation) first — covers the
 *    common case where token + pool are deployed in the same tx or same block.
 * 2. If that finds nothing, the token was pre-deployed (e.g. via CREATE2 vanity
 *    address). Fall back to a wider backwards scan from deployBlock in chunks
 *    of 10k blocks, up to 200k blocks back (~4 days on Base).
 *    Each chunk stays within provider block-range limits.
 *
 * Every failed RPC call (per-pass or per-chunk) is logged so silent RPC
 * throttling doesn't look identical to "this token genuinely predates our
 * lookback window."
 */
async function getDeployer(
  client: AnyClient,
  tokenAddress: Address,
  fromBlock: bigint,
  toBlock: bigint
): Promise<DeployerResult> {
  // ── Pass 1: tight window around pool creation ─────────────────────────────
  try {
    const logs = await client.getLogs({
      address: tokenAddress,
      event: TRANSFER_EVENT_ABI[0],
      args: { from: NULL_ADDRESS as Address },
      fromBlock,
      toBlock,
    });
    if (logs.length > 0) {
      const sorted = [...logs].sort((a, b) =>
        a.blockNumber! < b.blockNumber! ? -1 : 1
      );
      const result = (sorted[0].args as { to: string }).to;
      if (result) {
        return { address: result, mintBlock: sorted[0].blockNumber ?? null, source: "tight" };
      }
    }
  } catch (err) {
    logRpcFailure("getDeployer", `tight-window scan [${fromBlock}, ${toBlock}] failed`, err);
    // fall through to wide scan
  }

  // ── Pass 2: walk backwards in 10k-block chunks up to 200k blocks ──────────
  const hardFloor = toBlock > MAX_LOOKBACK ? toBlock - MAX_LOOKBACK : 0n;

  let chunkEnd = fromBlock > 1n ? fromBlock - 1n : 0n;
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
        const sorted = [...logs].sort((a, b) =>
          a.blockNumber! < b.blockNumber! ? -1 : 1
        );
        const result = (sorted[0].args as { to: string }).to;
        if (result) {
          return { address: result, mintBlock: sorted[0].blockNumber ?? null, source: "wide" };
        }
      }
    } catch (err) {
      logRpcFailure("getDeployer", `wide-scan chunk [${chunkStart}, ${chunkEnd}] failed`, err);
      // chunk failed — skip it and keep walking back
    }
    if (chunkStart === 0n) break;
    chunkEnd = chunkStart - 1n;
  }

  return { address: "unknown", mintBlock: null, source: "unknown" };
}

/**
 * Fetch just the mint amount for a token at a known block, as a floor
 * estimate of the deployer's balance when the mint happened outside the
 * holder-balance scan window (see the "deployerBalanceIsEstimate" note in
 * runRugCheck). This deliberately does NOT reflect any transfers since the
 * mint — it's a best-effort minimum, not a live balance.
 */
async function getMintAmount(
  client: AnyClient,
  tokenAddress: Address,
  mintBlock: bigint
): Promise<bigint | null> {
  try {
    const logs = await client.getLogs({
      address: tokenAddress,
      event: TRANSFER_EVENT_ABI[0],
      args: { from: NULL_ADDRESS as Address },
      fromBlock: mintBlock,
      toBlock: mintBlock,
    });
    if (logs.length === 0) return null;
    return logs.reduce(
      (sum, l) => sum + ((l.args as { value: bigint }).value ?? 0n),
      0n
    );
  } catch (err) {
    logRpcFailure("getMintAmount", `failed at block ${mintBlock}`, err);
    return null;
  }
}

/**
 * Fetch balances of holders by scanning Transfer events in [fromBlock, latest].
 * Returns a map of address → balance (bigint), or null if the scan itself
 * failed (as opposed to succeeding with zero results).
 */
async function getHolderBalances(
  client: AnyClient,
  tokenAddress: Address,
  fromBlock: bigint
): Promise<Map<string, bigint> | null> {
  try {
    const logs = await client.getLogs({
      address: tokenAddress,
      event: TRANSFER_EVENT_ABI[0],
      fromBlock,
      toBlock: "latest",
    });

    const balances = new Map<string, bigint>();
    for (const log of logs) {
      const args = log.args as { from: string; to: string; value: bigint };
      const { from, to, value } = args;
      if (!value) continue;

      if (from !== NULL_ADDRESS) {
        balances.set(from, (balances.get(from) ?? 0n) - value);
      }
      balances.set(to, (balances.get(to) ?? 0n) + value);
    }
    // Clean up zero/negative balances (dust/burn)
    for (const [addr, bal] of balances) {
      if (bal <= 0n) balances.delete(addr);
    }
    return balances;
  } catch (err) {
    logRpcFailure("getHolderBalances", `scan from block ${fromBlock} failed`, err);
    return null;
  }
}

/**
 * Check whether the token contract is a transparent/UUPS proxy by reading
 * the EIP-1967 implementation storage slot. Non-zero → proxy detected.
 * Returns null (not false!) if the storage read fails — a failed read must
 * never be silently reported as "confirmed not a proxy."
 */
async function checkProxy(
  client: AnyClient,
  tokenAddress: Address
): Promise<boolean | null> {
  try {
    const value = await client.getStorageAt({
      address: tokenAddress,
      slot: EIP1967_IMPL_SLOT,
    });
    if (value === undefined) return null;
    return value !== ZERO_SLOT;
  } catch (err) {
    logRpcFailure("checkProxy", "storage slot read failed", err);
    return null;
  }
}

// ─── Main scorer ─────────────────────────────────────────────────────────────

/**
 * Run the full rug-check pipeline on a newly detected token.
 *
 * @param client       viem PublicClient connected to Base mainnet
 * @param tokenAddress The new token to analyse
 * @param poolAddress  The Uniswap V3 pool that was just created
 * @param pairedAsset  Human label for the quote asset (e.g. "WETH")
 * @param deployBlock  Block number of the pool creation tx (scan anchor)
 */
export async function runRugCheck(
  client: AnyClient,
  tokenAddress: Address,
  poolAddress: Address,
  pairedAsset: string,
  deployBlock: bigint
): Promise<RugCheckResult> {
  const flags: RiskFlag[] = [];

  // ── 1. Fetch basic ERC-20 metadata ─────────────────────────────────────────
  const [totalSupply, decimals] = await Promise.all([
    safeRead(
      () => client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "totalSupply" }) as Promise<bigint>,
      0n,
      "totalSupply"
    ),
    safeRead(
      () => client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "decimals" }) as Promise<number>,
      18,
      "decimals"
    ),
  ]);

  // ── 2. Ownership check ─────────────────────────────────────────────────────
  //
  // Three distinct outcomes — we must not conflate them:
  //   a) owner() returns 0x000...0000  → verified renounced  ✅
  //   b) owner() returns a real address → owner is active    ❌
  //   c) owner() reverts / call fails   → indeterminate      ⚠️
  //
  // Treating (c) as "unknown" → ownershipRenounced=true would be the
  // dangerous direction: a malicious token with a custom contract that
  // doesn't implement Ownable would get a green "Renounced: ✅ Yes" for free.
  // So (c) raises a MEDIUM flag instead of silently passing.

  let ownerAddress: string;
  let ownerCallFailed = false;
  try {
    ownerAddress = await client.readContract({
      address: tokenAddress,
      abi: OWNER_ABI,
      functionName: "owner",
    }) as string;
  } catch (err) {
    logRpcFailure("owner", "owner() call failed", err);
    ownerAddress = "unknown";
    ownerCallFailed = true;
  }

  // Only mark renounced when we got an explicit zero address back
  const ownershipRenounced = ownerAddress === NULL_ADDRESS;

  if (ownerCallFailed) {
    // Could not verify — flag it but keep points low (not necessarily malicious)
    flags.push({
      id: "ownership_indeterminate",
      label: "Ownership indeterminate — owner() call failed",
      detail: `owner() reverted or is not implemented. Cannot confirm renounce status — manual review recommended.`,
      severity: "MEDIUM",
      points: 10,
    });
  } else if (!ownershipRenounced) {
    flags.push({
      id: "ownership_not_renounced",
      label: "Ownership not renounced",
      detail: `Owner is ${ownerAddress} — contract can be modified or rugged post-launch.`,
      severity: "HIGH",
      points: 25,
    });
  }

  // ── 3. Proxy check ─────────────────────────────────────────────────────────
  const isProxy = await checkProxy(client, tokenAddress);
  if (isProxy === null) {
    flags.push({
      id: "proxy_indeterminate",
      label: "Proxy status could not be verified",
      detail: `EIP-1967 storage slot read failed — cannot confirm whether logic is upgradeable. Manual review recommended.`,
      severity: "MEDIUM",
      points: 10,
    });
  } else if (isProxy) {
    flags.push({
      id: "upgradeable_proxy",
      label: "Upgradeable proxy detected",
      detail: `EIP-1967 implementation slot is non-zero — logic can be swapped silently.`,
      severity: "CRITICAL",
      points: 35,
    });
  }

  // ── 4. Deployer / dev wallet concentration ─────────────────────────────────
  //
  // Pass 1: tight window around pool creation (covers same-block deploy+pool).
  // Pass 2: chunked backwards scan up to 200k blocks (covers vanity/CREATE2
  //         tokens deployed days before the pool was created).

  const MINT_LOOKBACK = 500n;
  const mintScanFrom =
    deployBlock > MINT_LOOKBACK ? deployBlock - MINT_LOOKBACK : 0n;

  const deployerResult = await getDeployer(client, tokenAddress, mintScanFrom, deployBlock);
  const deployerAddress = deployerResult.address;

  // Holder-balance scan window. This does NOT automatically extend to cover
  // a deployer mint found by the wide scan (that could mean re-scanning up
  // to 200k blocks of full Transfer history, which is expensive and can
  // trip provider rate limits on its own). Instead we detect the gap below
  // and patch just the deployer's figure with a clearly-labelled estimate.
  const holderScanFrom = deployBlock > 10_000n ? deployBlock - 10_000n : 0n;
  const holderBalances = await getHolderBalances(client, tokenAddress, holderScanFrom);
  const holderDataAvailable = holderBalances !== null;

  let deployerBalance =
    holderBalances && deployerAddress !== "unknown"
      ? holderBalances.get(deployerAddress.toLowerCase()) ?? 0n
      : 0n;
  let deployerBalanceIsEstimate = false;

  // If the deployer's mint happened before our holder-scan window (the
  // "wide scan" case), the lookup above is meaningless — it will always
  // read 0 because the mint transfer simply isn't in the scanned range.
  // Fetch just the mint amount as a floor estimate instead of silently
  // reporting "Dev hold: 0.00%", which looks clean but isn't verified.
  if (
    deployerResult.source === "wide" &&
    deployerResult.mintBlock !== null &&
    deployerResult.mintBlock < holderScanFrom &&
    deployerBalance === 0n
  ) {
    const mintAmount = await getMintAmount(client, tokenAddress, deployerResult.mintBlock);
    if (mintAmount !== null && mintAmount > 0n) {
      deployerBalance = mintAmount;
      deployerBalanceIsEstimate = true;
    }
  }

  const deployerPct: number | null =
    deployerAddress === "unknown" || totalSupply === 0n
      ? null
      : Number((deployerBalance * 10_000n) / totalSupply) / 100;

  if (!holderDataAvailable) {
    flags.push({
      id: "holder_data_indeterminate",
      label: "Holder distribution could not be verified",
      detail: `Transfer event scan failed — dev wallet % and top-5 concentration are unverified. Manual review recommended.`,
      severity: "MEDIUM",
      points: 10,
    });
  } else if (deployerBalanceIsEstimate) {
    flags.push({
      id: "dev_wallet_estimate",
      label: "Dev wallet % is a floor estimate",
      detail: `Deployer mint (block ${deployerResult.mintBlock}) occurred before the holder-scan window. Shown % reflects only the original mint and excludes any transfers since — actual current holdings may be higher or lower.`,
      severity: "MEDIUM",
      points: 10,
    });
  }

  if (deployerPct !== null) {
    if (deployerPct >= DEV_PCT_CRITICAL) {
      flags.push({
        id: "dev_wallet_critical",
        label: "Dev wallet holds >50% supply",
        detail: `Deployer (${deployerAddress}) holds ${deployerPct.toFixed(1)}% of total supply — instant dump risk.`,
        severity: "CRITICAL",
        points: 40,
      });
    } else if (deployerPct >= DEV_PCT_HIGH) {
      flags.push({
        id: "dev_wallet_high",
        label: "Dev wallet holds >20% supply",
        detail: `Deployer (${deployerAddress}) holds ${deployerPct.toFixed(1)}% of total supply.`,
        severity: "HIGH",
        points: 20,
      });
    }
  }

  // ── 5. Top-5 holder concentration (excluding pool address) ─────────────────
  let top5HoldersPct: number | null = null;
  if (holderBalances) {
    const sortedHolders = [...holderBalances.entries()]
      .filter(([addr]) => addr.toLowerCase() !== poolAddress.toLowerCase())
      .sort((a, b) => (b[1] > a[1] ? 1 : -1));

    const top5Balance = sortedHolders
      .slice(0, 5)
      .reduce((acc, [, bal]) => acc + bal, 0n);

    top5HoldersPct =
      totalSupply > 0n ? Number((top5Balance * 10_000n) / totalSupply) / 100 : 0;

    if (top5HoldersPct >= TOP5_PCT_HIGH) {
      flags.push({
        id: "concentrated_holders",
        label: "Top 5 wallets hold >60% supply",
        detail: `Top 5 non-pool holders control ${top5HoldersPct.toFixed(1)}% of supply — coordinated dump risk.`,
        severity: "HIGH",
        points: 20,
      });
    }
  }

  // ── 6. Pool liquidity check ─────────────────────────────────────────────────
  const poolLiquidity = await safeReadNullable(
    () => client.readContract({ address: poolAddress, abi: POOL_LIQUIDITY_ABI, functionName: "liquidity" }) as Promise<bigint>,
    "pool.liquidity"
  );
  const liquidityLocked = poolLiquidity === null ? null : poolLiquidity > 0n;

  // Approximate ETH-equivalent from sqrtPriceX96 + liquidity
  // L / (sqrt(P) / 2^96) gives token1 per tick-unit; we approximate in ETH
  let initialLiquidityEth = 0;
  if (poolLiquidity !== null && poolLiquidity > 0n) {
    // slot0() has a positional (tuple) ABI, not a named-object one — viem
    // returns it as a readonly array in output order, so it must be
    // destructured by index, not by property name. The old code cast the
    // tuple straight to `{ sqrtPriceX96: bigint }`, which TypeScript never
    // actually validated (the cast bypassed the type system entirely) and
    // which would read `undefined` at runtime, silently producing "n/a" ETH
    // liquidity even when the read succeeded.
    const slot0 = await safeReadNullable(
      () =>
        client.readContract({
          address: poolAddress,
          abi: POOL_SLOT0_ABI,
          functionName: "slot0",
        }),
      "pool.slot0"
    );
    const sqrtPriceX96 = slot0 ? slot0[0] : null;
    if (sqrtPriceX96 && sqrtPriceX96 > 0n) {
      // ETH in pool ≈ L / (sqrtPrice / 2^96)
      // Using BigInt arithmetic then converting to float
      const Q96 = 2n ** 96n;
      const ethInPool = (poolLiquidity * Q96) / sqrtPriceX96;
      initialLiquidityEth = Number(formatEther(ethInPool));
    }
  }

  if (poolLiquidity === null) {
    flags.push({
      id: "liquidity_indeterminate",
      label: "Liquidity could not be verified",
      detail: `pool.liquidity() call failed — cannot confirm whether the pool is tradeable. Treat as unknown, not confirmed safe. Manual review recommended.`,
      severity: "MEDIUM",
      points: 15,
    });
  } else if (!liquidityLocked) {
    flags.push({
      id: "no_liquidity",
      label: "Zero in-range liquidity",
      detail: `Pool reports 0 liquidity — token may not be tradeable yet or liquidity was removed.`,
      severity: "CRITICAL",
      points: 40,
    });
  } else if (initialLiquidityEth < MIN_LIQUIDITY_ETH && initialLiquidityEth > 0) {
    flags.push({
      id: "low_liquidity",
      label: `Low liquidity (~${initialLiquidityEth.toFixed(3)} ETH)`,
      detail: `Initial pool liquidity is very low (~${initialLiquidityEth.toFixed(3)} ETH equivalent) — easy to manipulate price.`,
      severity: "MEDIUM",
      points: 15,
    });
  }

  // ── 7. Zero total supply edge case ─────────────────────────────────────────
  if (totalSupply === 0n) {
    flags.push({
      id: "zero_supply",
      label: "Total supply returned zero",
      detail: `totalSupply() returned 0 — contract may be non-standard or broken.`,
      severity: "HIGH",
      points: 20,
    });
  }

  // ── 8. Tally score & verdict ───────────────────────────────────────────────
  const score = Math.min(
    100,
    flags.reduce((acc, f) => acc + f.points, 0)
  );

  let verdict: RiskLevel = "LOW";
  if (score >= VERDICT_THRESHOLDS.CRITICAL) verdict = "CRITICAL";
  else if (score >= VERDICT_THRESHOLDS.HIGH) verdict = "HIGH";
  else if (score >= VERDICT_THRESHOLDS.MEDIUM) verdict = "MEDIUM";

  const flagLabels = flags.map((f) => f.label).join(", ");
  const summary =
    flags.length === 0
      ? `No major risk flags detected. Score: ${score}/100.`
      : `${verdict} risk (${score}/100): ${flagLabels}.`;

  return {
    tokenAddress,
    poolAddress,
    pairedAsset,
    ownerAddress,
    ownershipRenounced,
    isProxy,
    totalSupply,
    decimals,
    deployerAddress,
    deployerBalance,
    deployerBalanceIsEstimate,
    deployerPct,
    top5HoldersPct,
    poolLiquidity,
    initialLiquidityEth,
    liquidityLocked,
    flags,
    score,
    verdict,
    summary,
  };
}

// ─── Report formatter ─────────────────────────────────────────────────────────

const VERDICT_EMOJI: Record<RiskLevel, string> = {
  LOW: "🟢",
  MEDIUM: "🟡",
  HIGH: "🟠",
  CRITICAL: "🔴",
};

const SEVERITY_EMOJI: Record<RiskLevel, string> = {
  LOW: "🟢",
  MEDIUM: "🟡",
  HIGH: "🟠",
  CRITICAL: "🔴",
};

/**
 * Format a RugCheckResult into a human-readable terminal report block.
 */
export function formatRugReport(r: RugCheckResult, meta: { name: string; symbol: string; totalSupplyFormatted: string }): string {
  const lines: string[] = [];
  const v = VERDICT_EMOJI[r.verdict];

  lines.push(`╔══ RUG CHECK REPORT ════════════════════════════════════════════`);
  lines.push(`║  Token    : ${meta.name} (${meta.symbol})`);
  lines.push(`║  Address  : ${r.tokenAddress}`);
  lines.push(`║  Pool     : ${r.poolAddress}`);
  lines.push(`║  Paired   : ${r.pairedAsset}`);
  lines.push(`║`);
  lines.push(`║  ── Ownership ──────────────────────────────────────────────`);
  lines.push(`║  Owner    : ${r.ownerAddress}`);
  lines.push(`║  Renounced: ${
    r.ownerAddress === "unknown"
      ? "⚠️  Unknown (call failed — see flags)"
      : r.ownershipRenounced
        ? "✅ Yes (verified zero address)"
        : "❌ No"
  }`);
  lines.push(`║  Proxy    : ${
    r.isProxy === null
      ? "⚠️  Unknown (storage read failed — see flags)"
      : r.isProxy
        ? "⚠️  Yes (upgradeable)"
        : "✅ No"
  }`);
  lines.push(`║`);
  lines.push(`║  ── Supply & Wallets ────────────────────────────────────────`);
  lines.push(`║  Supply   : ${meta.totalSupplyFormatted} ${meta.symbol}`);
  lines.push(`║  Deployer : ${r.deployerAddress}`);
  lines.push(`║  Dev hold : ${
    r.deployerPct === null
      ? "n/a (unverified)"
      : `${r.deployerPct.toFixed(2)}% of supply${r.deployerBalanceIsEstimate ? " (floor estimate)" : ""}`
  }`);
  lines.push(`║  Top-5    : ${
    r.top5HoldersPct === null ? "n/a (unverified)" : `${r.top5HoldersPct.toFixed(2)}% of supply (excl. pool)`
  }`);
  lines.push(`║`);
  lines.push(`║  ── Liquidity ───────────────────────────────────────────────`);
  lines.push(`║  In-range : ${
    r.poolLiquidity === null
      ? "⚠️  Unknown (call failed — see flags)"
      : r.liquidityLocked
        ? `✅ Yes (liquidity units: ${r.poolLiquidity.toLocaleString()})`
        : "❌ Zero"
  }`);
  lines.push(`║  ~ETH     : ${r.initialLiquidityEth > 0 ? r.initialLiquidityEth.toFixed(4) + " ETH" : "n/a"}`);
  lines.push(`║`);
  lines.push(`║  ── Risk Flags (${r.flags.length}) ────────────────────────────────────────`);

  if (r.flags.length === 0) {
    lines.push(`║  ✅ No risk flags raised`);
  } else {
    for (const flag of r.flags) {
      lines.push(`║  ${SEVERITY_EMOJI[flag.severity]} [${flag.severity}] ${flag.label}`);
      lines.push(`║     → ${flag.detail}`);
    }
  }

  lines.push(`║`);
  lines.push(`║  ── Verdict ─────────────────────────────────────────────────`);
  lines.push(`║  Score    : ${r.score}/100`);
  lines.push(`║  Verdict  : ${v} ${r.verdict}`);
  lines.push(`║  Summary  : ${r.summary}`);
  lines.push(`║  BaseScan : https://basescan.org/address/${r.tokenAddress}`);
  lines.push(`╚════════════════════════════════════════════════════════════════`);

  return lines.join("\n");
}