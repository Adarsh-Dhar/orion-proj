/**
 * rugcheck.ts
 *
 * Exports:
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
} from "viem";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

import { collectEvidence }   from "./evidence.js";
import { scoreWithLLM }      from "./llm-score.js";
import type { TokenEvidence } from "./evidence.js";
import type { BotState } from "./state.js";
import { getDeployerHistory, recordDeployerToken } from "./state.js";

// ─── Re-export shared types ───────────────────────────────────────────────────

export type { RiskLevel, RiskFlag, RugCheckResult } from "./rugcheck-types.js";
import type { RiskLevel, RiskFlag, RugCheckResult } from "./rugcheck-types.js";

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
  opts?: { userQuestion?: string; mode?: "alert" | "chat"; state?: BotState }
): Promise<RugCheckResult> {

  // ── 1. Check deployer history from persistent state (before evidence collection) ─────────────────────
  let deployerHistoryData = { deployerSeenBefore: false, deployerPriorTokens: [] };
  if (opts?.state) {
    // We'll get the deployer address after evidence collection, so we use a placeholder
    // This will be updated after we know the deployer address
  }

  // ── 2. Collect evidence ───────────────────────────────────────────────────
  const evidence: TokenEvidence = await collectEvidence(
    client, tokenAddress, poolAddress, pairedAsset, deployBlock, meta, deployerHistoryData, opts?.state
  );

  // ── 3. Update deployer history from persistent state ──────────────────────
  if (opts?.state && evidence.deployerAddress) {
    const priorTokens = getDeployerHistory(opts.state, evidence.deployerAddress);
    evidence.deployerSeenBefore = priorTokens.length > 0;
    evidence.deployerPriorTokens = priorTokens;
    // Record this new token for the deployer
    recordDeployerToken(opts.state, evidence.deployerAddress, tokenAddress);
  }

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
      liquidityDeltaPct: evidence.liquidityDeltaPct,
      liquidityPreviousReading: evidence.liquidityPreviousReading,
      snapshotAgeMinutes: evidence.snapshotAgeMinutes,
      sellTestPassed: evidence.sellTestPassed,
      sellTestAmountSent: evidence.sellTestAmountSent,
      sellTestError: evidence.sellTestError,
      lpTokenId: evidence.lpTokenId,
      lpPositionOwner: evidence.lpPositionOwner,
      lpPositionStatus: evidence.lpPositionStatus,
      liquidityEverPulled: evidence.liquidityEverPulled,
      burnEventCount: evidence.burnEventCount,
      sourceVerified: evidence.sourceVerified,
      suspiciousFunctions: evidence.suspiciousFunctions,
      deployerSeenBefore: evidence.deployerSeenBefore,
      deployerPriorTokens: evidence.deployerPriorTokens,
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
    liquidityDeltaPct: evidence.liquidityDeltaPct,
    liquidityPreviousReading: evidence.liquidityPreviousReading,
    snapshotAgeMinutes: evidence.snapshotAgeMinutes,
    sellTestPassed: evidence.sellTestPassed,
    sellTestAmountSent: evidence.sellTestAmountSent,
    sellTestError: evidence.sellTestError,
    lpTokenId: evidence.lpTokenId,
    lpPositionOwner: evidence.lpPositionOwner,
    lpPositionStatus: evidence.lpPositionStatus,
    liquidityEverPulled: evidence.liquidityEverPulled,
    burnEventCount: evidence.burnEventCount,
    sourceVerified: evidence.sourceVerified,
    suspiciousFunctions: evidence.suspiciousFunctions,
    deployerSeenBefore: evidence.deployerSeenBefore,
    deployerPriorTokens: evidence.deployerPriorTokens,
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
  lines.push(`║  ── Advanced Checks ─────────────────────────────────────────────`);
  lines.push(`║  Sell test: ${
    r.sellTestPassed === null ? "⚠️  Not run (" + (r.sellTestError || "no holder") + ")"
      : r.sellTestPassed ? "✅ Passed" : "❌ Failed"
  }`);
  lines.push(`║  LP status: ${
    r.lpPositionStatus === "unverified" ? "⚠️  Unknown"
      : r.lpPositionStatus === "burned" ? "🔥 Burned"
      : r.lpPositionStatus === "locked_uncx" ? "🔒 Locked (UNCX)"
      : r.lpPositionStatus === "held_by_eoa" ? "👛 Held by EOA"
      : "📋 Non-NFT position"
  }`);
  lines.push(`║  Liquidity pulled: ${r.liquidityEverPulled ? "⚠️  Yes (" + r.burnEventCount + " events)" : "✅ No"}`);
  lines.push(`║  Source verified: ${
    r.sourceVerified === null ? "⚠️  Unknown"
      : r.sourceVerified ? "✅ Yes" : "❌ No"
  }`);
  if (r.deployerSeenBefore) {
    lines.push(`║  Deployer history: ⚠️  Seen before (${r.deployerPriorTokens.length} prior tokens)`);
  }
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
