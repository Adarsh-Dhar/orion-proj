import {
  type PublicClient,
  type Address,
  formatUnits,
  formatEther,
} from "viem";
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
  isProxy: boolean;

  // ── Supply / dev wallet ────────────────────────────────────────────────────
  totalSupply: bigint;
  decimals: number;
  deployerAddress: string;
  deployerBalance: bigint;
  deployerPct: number;        // % of total supply held by deployer
  top5HoldersPct: number;     // % held by top 5 non-pool addresses

  // ── Liquidity ──────────────────────────────────────────────────────────────
  poolLiquidity: bigint;      // raw in-range liquidity units
  initialLiquidityEth: number; // approx ETH-equivalent locked at launch
  liquidityLocked: boolean;   // true if pool has non-zero in-range liquidity

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function safeRead<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** Resolve the deployer address from the token's first mint (Transfer from 0x0).
 *
 * Scans only within [fromBlock, toBlock] — a tight window around the deploy tx.
 * Avoids the fromBlock:0n pattern that every real RPC provider rejects with a
 * "block range too large" error, which previously always silently returned "unknown".
 */
async function getDeployer(
  client: PublicClient,
  tokenAddress: Address,
  fromBlock: bigint,
  toBlock: bigint
): Promise<string> {
  try {
    const logs = await client.getLogs({
      address: tokenAddress,
      event: TRANSFER_EVENT_ABI[0],
      args: { from: NULL_ADDRESS as Address },
      fromBlock,
      toBlock,
    });
    if (logs.length === 0) return "unknown";
    // Sort ascending and take the earliest mint
    const sorted = [...logs].sort((a, b) =>
      a.blockNumber! < b.blockNumber! ? -1 : 1
    );
    const firstMint = sorted[0];
    return (firstMint.args as { to: string }).to ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Fetch balances of the top N unique holders by scanning Transfer events.
 * Returns a map of address → balance (bigint).
 * Capped at the most recent 2000 events to stay within RPC limits.
 */
async function getHolderBalances(
  client: PublicClient,
  tokenAddress: Address,
  fromBlock: bigint
): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>();
  try {
    const logs = await client.getLogs({
      address: tokenAddress,
      event: TRANSFER_EVENT_ABI[0],
      fromBlock,
      toBlock: "latest",
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
    // Clean up zero/negative balances (dust/burn)
    for (const [addr, bal] of balances) {
      if (bal <= 0n) balances.delete(addr);
    }
  } catch {
    // Return empty map on failure — scorer handles it gracefully
  }
  return balances;
}

/**
 * Check whether the token contract is a transparent/UUPS proxy by reading
 * the EIP-1967 implementation storage slot. Non-zero → proxy detected.
 */
async function checkProxy(
  client: PublicClient,
  tokenAddress: Address
): Promise<boolean> {
  try {
    const value = await client.getStorageAt({
      address: tokenAddress,
      slot: EIP1967_IMPL_SLOT,
    });
    // Non-zero and non-null address in slot = proxy
    return (
      !!value &&
      value !== "0x0000000000000000000000000000000000000000000000000000000000000000"
    );
  } catch {
    return false;
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
  client: PublicClient,
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
      0n
    ),
    safeRead(
      () => client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "decimals" }) as Promise<number>,
      18
    ),
  ]);

  // ── 2. Ownership check ─────────────────────────────────────────────────────
  //
  // Three distinct outcomes — we must not conflate them:
  //   a) owner() returns 0x000...0000  → verified renounced  ✅
  //   b) owner() returns a real address → owner is active    ❌
  //   c) owner() reverts / call fails   → indeterminate      ⚠️
  //
  // The old code treated (c) the same as (a) — "unknown" → ownershipRenounced=true.
  // That's the dangerous direction: a malicious token with a custom contract that
  // doesn't implement Ownable gets a green "Renounced: ✅ Yes" for free.
  // Now (c) raises a MEDIUM flag instead of silently passing.

  let ownerAddress: string;
  let ownerCallFailed = false;
  try {
    ownerAddress = await client.readContract({
      address: tokenAddress,
      abi: OWNER_ABI,
      functionName: "owner",
    }) as string;
  } catch {
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
  if (isProxy) {
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
  // OLD: getDeployer() used fromBlock: 0n — scanning from genesis.
  // Infura (and most providers) reject eth_getLogs with a range > 10k blocks,
  // so that always failed silently, always returned "unknown", always showed
  // Dev hold: 0.00% regardless of reality.
  //
  // FIX: anchor the mint-scan to deployBlock. The token was deployed at or
  // just before the pool creation, so the mint tx is always within a very
  // small window of deployBlock. We look back a maximum of 500 blocks
  // (~16 minutes) to be safe, well within any provider's block range limit.

  const MINT_LOOKBACK = 500n;
  const mintScanFrom =
    deployBlock > MINT_LOOKBACK ? deployBlock - MINT_LOOKBACK : 0n;

  const deployerAddress = await getDeployer(
    client,
    tokenAddress,
    mintScanFrom,
    deployBlock
  );

  // Scan holder balances from mint window (cap to ~10k blocks = ~5h on Base)
  const scanFrom = deployBlock > 10_000n ? deployBlock - 10_000n : 0n;
  const holderBalances = await getHolderBalances(client, tokenAddress, scanFrom);

  const deployerBalance =
    deployerAddress !== "unknown"
      ? (holderBalances.get(deployerAddress.toLowerCase()) ?? 0n)
      : 0n;

  const deployerPct =
    totalSupply > 0n
      ? Number((deployerBalance * 10_000n) / totalSupply) / 100
      : 0;

  // If holder scan returned nothing, flag that wallet data is indeterminate
  // rather than silently showing 0.00% which looks clean but is uninformative
  const holderDataAvailable = holderBalances.size > 0;

  if (!holderDataAvailable) {
    flags.push({
      id: "holder_data_indeterminate",
      label: "Holder distribution could not be verified",
      detail: `Transfer event scan returned no data — dev wallet % and top-5 concentration are unverified. Manual review recommended.`,
      severity: "MEDIUM",
      points: 10,
    });
  }

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

  // ── 5. Top-5 holder concentration (excluding pool address) ─────────────────
  const sortedHolders = [...holderBalances.entries()]
    .filter(([addr]) => addr.toLowerCase() !== poolAddress.toLowerCase())
    .sort((a, b) => (b[1] > a[1] ? 1 : -1));

  const top5Balance = sortedHolders
    .slice(0, 5)
    .reduce((acc, [, bal]) => acc + bal, 0n);

  const top5HoldersPct =
    totalSupply > 0n
      ? Number((top5Balance * 10_000n) / totalSupply) / 100
      : 0;

  if (top5HoldersPct >= TOP5_PCT_HIGH) {
    flags.push({
      id: "concentrated_holders",
      label: "Top 5 wallets hold >60% supply",
      detail: `Top 5 non-pool holders control ${top5HoldersPct.toFixed(1)}% of supply — coordinated dump risk.`,
      severity: "HIGH",
      points: 20,
    });
  }

  // ── 6. Pool liquidity check ─────────────────────────────────────────────────
  const poolLiquidity = await safeRead(
    () => client.readContract({ address: poolAddress, abi: POOL_LIQUIDITY_ABI, functionName: "liquidity" }) as Promise<bigint>,
    0n
  );
  const liquidityLocked = poolLiquidity > 0n;

  // Approximate ETH-equivalent from sqrtPriceX96 + liquidity
  // L / (sqrt(P) / 2^96) gives token1 per tick-unit; we approximate in ETH
  let initialLiquidityEth = 0;
  try {
    const slot0 = await client.readContract({
      address: poolAddress,
      abi: POOL_SLOT0_ABI,
      functionName: "slot0",
    }) as { sqrtPriceX96: bigint };

    const sqrtPrice = slot0.sqrtPriceX96;
    if (sqrtPrice > 0n && poolLiquidity > 0n) {
      // ETH in pool ≈ L / (sqrtPrice / 2^96)
      // Using BigInt arithmetic then converting to float
      const Q96 = 2n ** 96n;
      const ethInPool = (poolLiquidity * Q96) / sqrtPrice;
      initialLiquidityEth = Number(formatEther(ethInPool));
    }
  } catch {
    initialLiquidityEth = 0;
  }

  if (!liquidityLocked) {
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
  lines.push(`║  Proxy    : ${r.isProxy ? "⚠️  Yes (upgradeable)" : "✅ No"}`);
  lines.push(`║`);
  lines.push(`║  ── Supply & Wallets ────────────────────────────────────────`);
  lines.push(`║  Supply   : ${meta.totalSupplyFormatted} ${meta.symbol}`);
  lines.push(`║  Deployer : ${r.deployerAddress}`);
  lines.push(`║  Dev hold : ${r.deployerPct.toFixed(2)}% of supply`);
  lines.push(`║  Top-5    : ${r.top5HoldersPct.toFixed(2)}% of supply (excl. pool)`);
  lines.push(`║`);
  lines.push(`║  ── Liquidity ───────────────────────────────────────────────`);
  lines.push(`║  In-range : ${r.liquidityLocked ? `✅ Yes (liquidity units: ${r.poolLiquidity.toLocaleString()})` : "❌ Zero"}`);
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
