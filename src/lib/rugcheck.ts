/**
 * rugcheck.ts
 *
 * Exports:
 *   runRugCheck(...)    — deterministic rule-based scorer (unchanged)
 *   runRugCheckLLM(...) — evidence collector + Gemini scorer
 *   formatRugReport(...)
 *
 * Types are defined in rugcheck-types.ts and re-exported from here so
 * existing callers don't need to change their import paths.
 */

import {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type PublicClient,
  type Address,
  formatEther,
} from "viem";

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
import { collectEvidence }   from "./evidence.js";
import { scoreWithLLM }      from "./llm-score.js";
import type { TokenEvidence } from "./evidence.js";

// ─── Re-export shared types ───────────────────────────────────────────────────

export type { RiskLevel, RiskFlag, RugCheckResult } from "./rugcheck-types.js";
import type { RiskLevel, RiskFlag, RugCheckResult } from "./rugcheck-types.js";

// ─── Constants (rule engine) ──────────────────────────────────────────────────

const VERDICT_THRESHOLDS: Record<RiskLevel, number> = {
  LOW: 0, MEDIUM: 25, HIGH: 50, CRITICAL: 75,
};
const MIN_LIQUIDITY_ETH  = 0.5;
const DEV_PCT_HIGH       = 20;
const DEV_PCT_CRITICAL   = 50;
const TOP5_PCT_HIGH      = 60;
const SCAN_CHUNK         = 10_000n;
const MAX_LOOKBACK       = 200_000n;
const ZERO_SLOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// ─── Shared helpers ───────────────────────────────────────────────────────────

function logRpcFailure(tag: string, context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`  [rugcheck:${tag}] ${context}: ${message}`);
}

async function safeRead<T>(fn: () => Promise<T>, fallback: T, tag: string): Promise<T> {
  try { return await fn(); }
  catch (err) { logRpcFailure(tag, "read failed, using fallback", err); return fallback; }
}

async function safeReadNullable<T>(fn: () => Promise<T>, tag: string): Promise<T | null> {
  try { return await fn(); }
  catch (err) { logRpcFailure(tag, "read failed", err); return null; }
}

interface DeployerResult {
  address: string;
  mintBlock: bigint | null;
  source: "tight" | "wide" | "unknown";
}

async function getDeployer(
  client: AnyClient,
  tokenAddress: Address,
  fromBlock: bigint,
  toBlock: bigint
): Promise<DeployerResult> {
  try {
    const logs = await client.getLogs({
      address: tokenAddress,
      event: TRANSFER_EVENT_ABI[0],
      args: { from: NULL_ADDRESS as Address },
      fromBlock,
      toBlock,
    });
    if (logs.length > 0) {
      const sorted = [...logs].sort((a, b) => (a.blockNumber! < b.blockNumber! ? -1 : 1));
      const result = (sorted[0].args as { to: string }).to;
      if (result) return { address: result, mintBlock: sorted[0].blockNumber ?? null, source: "tight" };
    }
  } catch (err) {
    logRpcFailure("getDeployer", `tight-window [${fromBlock}, ${toBlock}] failed`, err);
  }

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
        const sorted = [...logs].sort((a, b) => (a.blockNumber! < b.blockNumber! ? -1 : 1));
        const result = (sorted[0].args as { to: string }).to;
        if (result) return { address: result, mintBlock: sorted[0].blockNumber ?? null, source: "wide" };
      }
    } catch (err) {
      logRpcFailure("getDeployer", `wide chunk [${chunkStart}, ${chunkEnd}] failed`, err);
    }
    if (chunkStart === 0n) break;
    chunkEnd = chunkStart - 1n;
  }
  return { address: "unknown", mintBlock: null, source: "unknown" };
}

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
    return logs.reduce((sum, l) => sum + ((l.args as { value: bigint }).value ?? 0n), 0n);
  } catch (err) {
    logRpcFailure("getMintAmount", `failed at block ${mintBlock}`, err);
    return null;
  }
}

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
      if (from !== NULL_ADDRESS) balances.set(from, (balances.get(from) ?? 0n) - value);
      balances.set(to, (balances.get(to) ?? 0n) + value);
    }
    for (const [addr, bal] of balances) { if (bal <= 0n) balances.delete(addr); }
    return balances;
  } catch (err) {
    logRpcFailure("getHolderBalances", `scan from block ${fromBlock} failed`, err);
    return null;
  }
}

async function checkProxy(client: AnyClient, tokenAddress: Address): Promise<boolean | null> {
  try {
    const value = await client.getStorageAt({ address: tokenAddress, slot: EIP1967_IMPL_SLOT });
    if (value === undefined) return null;
    return value !== ZERO_SLOT;
  } catch (err) {
    logRpcFailure("checkProxy", "storage slot read failed", err);
    return null;
  }
}

// ─── Rule-based scorer (unchanged) ───────────────────────────────────────────

export async function runRugCheck(
  client: AnyClient,
  tokenAddress: Address,
  poolAddress: Address,
  pairedAsset: string,
  deployBlock: bigint
): Promise<RugCheckResult> {
  const flags: RiskFlag[] = [];

  const [totalSupply, decimals] = await Promise.all([
    safeRead(() => client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "totalSupply" }) as Promise<bigint>, 0n, "totalSupply"),
    safeRead(() => client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "decimals" })   as Promise<number>, 18, "decimals"),
  ]);

  let ownerAddress: string;
  let ownerCallFailed = false;
  try {
    ownerAddress = await client.readContract({ address: tokenAddress, abi: OWNER_ABI, functionName: "owner" }) as string;
  } catch (err) {
    logRpcFailure("owner", "owner() call failed", err);
    ownerAddress = "unknown";
    ownerCallFailed = true;
  }
  const ownershipRenounced = ownerAddress === NULL_ADDRESS;
  if (ownerCallFailed) {
    flags.push({ id: "ownership_indeterminate", label: "Ownership indeterminate — owner() call failed", detail: "owner() reverted or is not implemented. Cannot confirm renounce status — manual review recommended.", severity: "MEDIUM", points: 10 });
  } else if (!ownershipRenounced) {
    flags.push({ id: "ownership_not_renounced", label: "Ownership not renounced", detail: `Owner is ${ownerAddress} — contract can be modified or rugged post-launch.`, severity: "HIGH", points: 25 });
  }

  const isProxy = await checkProxy(client, tokenAddress);
  if (isProxy === null) {
    flags.push({ id: "proxy_indeterminate", label: "Proxy status could not be verified", detail: "EIP-1967 storage slot read failed — cannot confirm whether logic is upgradeable. Manual review recommended.", severity: "MEDIUM", points: 10 });
  } else if (isProxy) {
    flags.push({ id: "upgradeable_proxy", label: "Upgradeable proxy detected", detail: "EIP-1967 implementation slot is non-zero — logic can be swapped silently.", severity: "CRITICAL", points: 35 });
  }

  const MINT_LOOKBACK = 500n;
  const mintScanFrom = deployBlock > MINT_LOOKBACK ? deployBlock - MINT_LOOKBACK : 0n;
  const deployerResult = await getDeployer(client, tokenAddress, mintScanFrom, deployBlock);
  const deployerAddress = deployerResult.address;

  const holderScanFrom = deployBlock > 10_000n ? deployBlock - 10_000n : 0n;
  const holderBalances = await getHolderBalances(client, tokenAddress, holderScanFrom);
  const holderDataAvailable = holderBalances !== null;

  let deployerBalance = holderBalances && deployerAddress !== "unknown"
    ? holderBalances.get(deployerAddress.toLowerCase()) ?? 0n : 0n;
  let deployerBalanceIsEstimate = false;

  if (deployerResult.source === "wide" && deployerResult.mintBlock !== null &&
      deployerResult.mintBlock < holderScanFrom && deployerBalance === 0n) {
    const mintAmount = await getMintAmount(client, tokenAddress, deployerResult.mintBlock);
    if (mintAmount !== null && mintAmount > 0n) { deployerBalance = mintAmount; deployerBalanceIsEstimate = true; }
  }

  const deployerPct: number | null = deployerAddress === "unknown" || totalSupply === 0n
    ? null : Number((deployerBalance * 10_000n) / totalSupply) / 100;

  if (!holderDataAvailable) {
    flags.push({ id: "holder_data_indeterminate", label: "Holder distribution could not be verified", detail: "Transfer event scan failed — dev wallet % and top-5 concentration are unverified. Manual review recommended.", severity: "MEDIUM", points: 10 });
  } else if (deployerBalanceIsEstimate) {
    flags.push({ id: "dev_wallet_estimate", label: "Dev wallet % is a floor estimate", detail: `Deployer mint (block ${deployerResult.mintBlock}) occurred before the holder-scan window. Shown % reflects only the original mint.`, severity: "MEDIUM", points: 10 });
  }

  if (deployerPct !== null) {
    if (deployerPct >= DEV_PCT_CRITICAL) {
      flags.push({ id: "dev_wallet_critical", label: "Dev wallet holds >50% supply", detail: `Deployer (${deployerAddress}) holds ${deployerPct.toFixed(1)}% of total supply — instant dump risk.`, severity: "CRITICAL", points: 40 });
    } else if (deployerPct >= DEV_PCT_HIGH) {
      flags.push({ id: "dev_wallet_high", label: "Dev wallet holds >20% supply", detail: `Deployer (${deployerAddress}) holds ${deployerPct.toFixed(1)}% of total supply.`, severity: "HIGH", points: 20 });
    }
  }

  let top5HoldersPct: number | null = null;
  if (holderBalances) {
    const sortedHolders = [...holderBalances.entries()]
      .filter(([addr]) => addr.toLowerCase() !== poolAddress.toLowerCase())
      .sort((a, b) => (b[1] > a[1] ? 1 : -1));
    const top5Balance = sortedHolders.slice(0, 5).reduce((acc, [, bal]) => acc + bal, 0n);
    top5HoldersPct = totalSupply > 0n ? Number((top5Balance * 10_000n) / totalSupply) / 100 : 0;
    if (top5HoldersPct >= TOP5_PCT_HIGH) {
      flags.push({ id: "concentrated_holders", label: "Top 5 wallets hold >60% supply", detail: `Top 5 non-pool holders control ${top5HoldersPct.toFixed(1)}% of supply — coordinated dump risk.`, severity: "HIGH", points: 20 });
    }
  }

  const poolLiquidity = await safeReadNullable(
    () => client.readContract({ address: poolAddress, abi: POOL_LIQUIDITY_ABI, functionName: "liquidity" }) as Promise<bigint>,
    "pool.liquidity"
  );
  const liquidityLocked = poolLiquidity === null ? null : poolLiquidity > 0n;

  let initialLiquidityEth = 0;
  if (poolLiquidity !== null && poolLiquidity > 0n) {
    const slot0 = await safeReadNullable(
      () => client.readContract({ address: poolAddress, abi: POOL_SLOT0_ABI, functionName: "slot0" }),
      "pool.slot0"
    );
    const sqrtPriceX96 = slot0 ? (slot0 as readonly [bigint, ...unknown[]])[0] : null;
    if (sqrtPriceX96 && sqrtPriceX96 > 0n) {
      initialLiquidityEth = Number(formatEther((poolLiquidity * 2n ** 96n) / sqrtPriceX96));
    }
  }

  if (poolLiquidity === null) {
    flags.push({ id: "liquidity_indeterminate", label: "Liquidity could not be verified", detail: "pool.liquidity() call failed — cannot confirm whether the pool is tradeable.", severity: "MEDIUM", points: 15 });
  } else if (!liquidityLocked) {
    flags.push({ id: "no_liquidity", label: "Zero in-range liquidity", detail: "Pool reports 0 liquidity — token may not be tradeable yet or liquidity was removed.", severity: "CRITICAL", points: 40 });
  } else if (initialLiquidityEth < MIN_LIQUIDITY_ETH && initialLiquidityEth > 0) {
    flags.push({ id: "low_liquidity", label: `Low liquidity (~${initialLiquidityEth.toFixed(3)} ETH)`, detail: `Initial pool liquidity is very low (~${initialLiquidityEth.toFixed(3)} ETH equivalent) — easy to manipulate price.`, severity: "MEDIUM", points: 15 });
  }

  if (totalSupply === 0n) {
    flags.push({ id: "zero_supply", label: "Total supply returned zero", detail: "totalSupply() returned 0 — contract may be non-standard or broken.", severity: "HIGH", points: 20 });
  }

  const score = Math.min(100, flags.reduce((acc, f) => acc + f.points, 0));
  let verdict: RiskLevel = "LOW";
  if (score >= VERDICT_THRESHOLDS.CRITICAL) verdict = "CRITICAL";
  else if (score >= VERDICT_THRESHOLDS.HIGH) verdict = "HIGH";
  else if (score >= VERDICT_THRESHOLDS.MEDIUM) verdict = "MEDIUM";

  const flagLabels = flags.map((f) => f.label).join(", ");
  const summary = flags.length === 0
    ? `No major risk flags detected. Score: ${score}/100.`
    : `${verdict} risk (${score}/100): ${flagLabels}.`;

  return {
    tokenAddress, poolAddress, pairedAsset,
    ownerAddress, ownershipRenounced, isProxy,
    totalSupply, decimals,
    deployerAddress, deployerBalance, deployerBalanceIsEstimate,
    deployerPct, top5HoldersPct,
    poolLiquidity, initialLiquidityEth, liquidityLocked,
    flags, score, verdict, summary,
    scoringMethod: "rules",
  };
}

// ─── LLM scorer ───────────────────────────────────────────────────────────────

/**
 * Collect all on-chain evidence via evidence.ts, log it to stdout, then
 * send it to Gemini for scoring.  The factual fields of RugCheckResult
 * (addresses, supply, liquidity) come from evidence — never from the LLM —
 * so numbers cannot be hallucinated.
 *
 * On LLM failure: forces score=100, verdict=CRITICAL, one flag, sets
 * scoringError. Fails loud, never quietly.
 */
export async function runRugCheckLLM(
  client: AnyClient,
  tokenAddress: Address,
  poolAddress: Address,
  pairedAsset: string,
  deployBlock: bigint,
  meta: { name: string; symbol: string; decimals: number; totalSupply: bigint; totalSupplyFormatted: string },
  opts?: { userQuestion?: string; mode?: "alert" | "chat" }
): Promise<RugCheckResult> {

  // ── 1. Collect evidence ───────────────────────────────────────────────────
  const evidence: TokenEvidence = await collectEvidence(
    client, tokenAddress, poolAddress, pairedAsset, deployBlock, meta
  );

  // Log full evidence block so every on-chain fact is visible in stdout
  console.log("\n  ── Raw Evidence ─────────────────────────────────────────────");
  console.log(JSON.stringify(evidence, null, 2)
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n"));
  console.log("  ─────────────────────────────────────────────────────────────\n");

  // ── 2. Derive factual fields from evidence (not from LLM) ────────────────
  const totalSupply     = meta.totalSupply;
  const decimals        = meta.decimals;
  const ownerAddress    = evidence.ownerAddress ?? "unknown";
  const ownershipRenounced = evidence.ownershipRenounced ?? false;
  const isProxy         = evidence.isProxy;
  const deployerAddress = evidence.deployerAddress ?? "unknown";
  const deployerBalance = BigInt(evidence.deployerCurrentBalance ?? "0");
  const deployerBalanceIsEstimate =
    evidence.rpcWarnings.some((w) => w.includes("floor estimate"));
  const deployerPct     = evidence.deployerPct;
  const top5HoldersPct  = evidence.top5HoldersPct;
  const poolLiquidity   = evidence.poolLiquidity !== null
    ? BigInt(evidence.poolLiquidity) : null;
  const liquidityLocked = evidence.liquidityLocked;
  const initialLiquidityEth = evidence.initialLiquidityEth ?? 0;

  // ── 3. Score with LLM ─────────────────────────────────────────────────────
  console.log("  Sending evidence to Gemini for scoring...");
  const llmResult = await scoreWithLLM(evidence, opts);

  if (!llmResult.ok) {
    console.error(`  [LLM] Scoring failed: ${llmResult.reason}`);
    const errorFlag: RiskFlag = {
      id:       "llm_scoring_failed",
      label:    "LLM scoring failed",
      detail:   `Gemini could not score this token: ${llmResult.reason}. Defaulting to maximum risk.`,
      severity: "CRITICAL",
      points:   100,
    };
    return {
      tokenAddress, poolAddress, pairedAsset,
      ownerAddress, ownershipRenounced, isProxy,
      totalSupply, decimals,
      deployerAddress, deployerBalance, deployerBalanceIsEstimate,
      deployerPct, top5HoldersPct,
      poolLiquidity, initialLiquidityEth, liquidityLocked,
      flags:   [errorFlag],
      score:   100,
      verdict: "CRITICAL",
      summary: `LLM scoring failed: ${llmResult.reason}`,
      scoringMethod: "llm",
      scoringError:  llmResult.reason,
    };
  }

  console.log(`  Gemini verdict: ${llmResult.verdict} (${llmResult.score}/100)`);

  return {
    tokenAddress, poolAddress, pairedAsset,
    ownerAddress, ownershipRenounced, isProxy,
    totalSupply, decimals,
    deployerAddress, deployerBalance, deployerBalanceIsEstimate,
    deployerPct, top5HoldersPct,
    poolLiquidity, initialLiquidityEth, liquidityLocked,
    flags:   llmResult.flags,
    score:   llmResult.score,
    verdict: llmResult.verdict,
    summary: llmResult.summary,
    scoringMethod: "llm",
    answer:  llmResult.answer,
  };
}

// ─── Report formatter ─────────────────────────────────────────────────────────

const VERDICT_EMOJI:  Record<RiskLevel, string> = { LOW: "🟢", MEDIUM: "🟡", HIGH: "🟠", CRITICAL: "🔴" };
const SEVERITY_EMOJI: Record<RiskLevel, string> = { LOW: "🟢", MEDIUM: "🟡", HIGH: "🟠", CRITICAL: "🔴" };

export function formatRugReport(
  r: RugCheckResult,
  meta: { name: string; symbol: string; totalSupplyFormatted: string }
): string {
  const lines: string[] = [];
  const v = VERDICT_EMOJI[r.verdict];
  const scoredBy = r.scoringMethod === "llm"
    ? `LLM (Gemini)${r.scoringError ? " — SCORING FAILED, see flags" : ""}`
    : "rule engine";

  lines.push(`╔══ RUG CHECK REPORT ════════════════════════════════════════════`);
  lines.push(`║  Token    : ${meta.name} (${meta.symbol})`);
  lines.push(`║  Address  : ${r.tokenAddress}`);
  lines.push(`║  Pool     : ${r.poolAddress}`);
  lines.push(`║  Paired   : ${r.pairedAsset}`);
  lines.push(`║  Scored by: ${scoredBy}`);
  lines.push(`║`);
  lines.push(`║  ── Ownership ──────────────────────────────────────────────`);
  lines.push(`║  Owner    : ${r.ownerAddress}`);
  lines.push(`║  Renounced: ${
    r.ownerAddress === "unknown"
      ? "⚠️  Unknown (call failed — see flags)"
      : r.ownershipRenounced ? "✅ Yes (verified zero address)" : "❌ No"
  }`);
  lines.push(`║  Proxy    : ${
    r.isProxy === null
      ? "⚠️  Unknown (storage read failed — see flags)"
      : r.isProxy ? "⚠️  Yes (upgradeable)" : "✅ No"
  }`);
  lines.push(`║`);
  lines.push(`║  ── Supply & Wallets ────────────────────────────────────────`);
  lines.push(`║  Supply   : ${meta.totalSupplyFormatted} ${meta.symbol}`);
  lines.push(`║  Deployer : ${r.deployerAddress}`);
  lines.push(`║  Dev hold : ${
    r.deployerPct === null ? "n/a (unverified)"
      : `${r.deployerPct.toFixed(2)}% of supply${r.deployerBalanceIsEstimate ? " (floor estimate)" : ""}`
  }`);
  lines.push(`║  Top-5    : ${
    r.top5HoldersPct === null ? "n/a (unverified)"
      : `${r.top5HoldersPct.toFixed(2)}% of supply (excl. pool)`
  }`);
  lines.push(`║`);
  lines.push(`║  ── Liquidity ───────────────────────────────────────────────`);
  lines.push(`║  In-range : ${
    r.poolLiquidity === null ? "⚠️  Unknown (call failed — see flags)"
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
  if (r.answer) {
    lines.push(`║`);
    lines.push(`║  ── Your Question ──────────────────────────────────────────────`);
    lines.push(`║  ${r.answer}`);
  }
  lines.push(`╚════════════════════════════════════════════════════════════════`);

  return lines.join("\n");
}

// ─── Alert card (sniper → notification channel) ────────────────────────────────

export function formatAlertCard(
  r: RugCheckResult,
  meta: { name: string; symbol: string; totalSupplyFormatted: string }
): string {
  const v = VERDICT_EMOJI[r.verdict];
  const lines: string[] = [];

  lines.push(`${v} ${r.verdict} — ${meta.name} ($${meta.symbol})  ·  ${r.score}/100`);
  lines.push(r.summary);

  const topFlags = [...r.flags].sort((a, b) => b.points - a.points).slice(0, 2);
  for (const f of topFlags) {
    lines.push(`${SEVERITY_EMOJI[f.severity]} ${f.label}`);
  }

  lines.push(r.tokenAddress);
  lines.push(`https://basescan.org/address/${r.tokenAddress}`);

  return lines.join("\n");
}

// ─── Chat reply (chat.ts / Telegram DM) ─────────────────────────────────────────

export function formatChatReply(
  r: RugCheckResult,
  meta: { name: string; symbol: string; totalSupplyFormatted: string }
): string {
  const v = VERDICT_EMOJI[r.verdict];
  const lines: string[] = [];

  if (r.answer) {
    lines.push(r.answer, "");
  }

  lines.push(`${v} ${r.verdict}  ·  ${r.score}/100  ·  ${meta.name} ($${meta.symbol})`);

  const topFlags = [...r.flags].sort((a, b) => b.points - a.points).slice(0, 3);
  if (topFlags.length > 0) {
    lines.push("");
    for (const f of topFlags) lines.push(`${SEVERITY_EMOJI[f.severity]} ${f.label} — ${f.detail}`);
  }

  lines.push("", r.tokenAddress, `Send /full ${r.tokenAddress} for the complete report.`);
  return lines.join("\n");
}
