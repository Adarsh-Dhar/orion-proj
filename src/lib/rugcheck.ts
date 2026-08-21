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
import { runAgentLoop } from "./agent-loop.js";
import type { ToolContext } from "./agent-tools.js";
import { storeAnalysis } from "./analysis-store.js";

// ─── Re-export shared types ───────────────────────────────────────────────────

export type { RiskLevel, RiskFlag, RugCheckResult } from "./rugcheck-types.js";
import type { RiskLevel, RiskFlag, RugCheckResult } from "./rugcheck-types.js";

// ─── Ambiguity detector ──────────────────────────────────────────────────────────

/**
 * Determine if the evidence is ambiguous and requires agentic investigation.
 * Returns true if the evidence shows conflicting signals or insufficient data.
 */
function isAmbiguous(evidence: TokenEvidence): boolean {
  // Conflicting signals: sell test passed but high concentration
  if (evidence.sellTestPassed === true && evidence.top5HoldersPct !== null && evidence.top5HoldersPct > 60) {
    return true;
  }

  // Source verification missing/null
  if (evidence.sourceVerified === null) {
    return true;
  }

  // Deployer seen before but otherwise clean signals
  if (evidence.deployerSeenBefore && evidence.sellTestPassed === true && evidence.liquidityLocked === true) {
    return true;
  }

  // Ownership renounced but LP not locked
  if (evidence.ownershipRenounced === true && evidence.lpPositionStatus === "held_by_eoa") {
    return true;
  }

  // Low liquidity but not zero
  if (evidence.initialLiquidityEth !== null && evidence.initialLiquidityEth > 0 && evidence.initialLiquidityEth < 0.5) {
    return true;
  }

  // Trade scan failed or partial
  if (evidence.tradeScanPartial) {
    return true;
  }

  // Holder scan partial
  if (evidence.holderScanPartial) {
    return true;
  }

  // Multiple RPC warnings
  if (evidence.rpcWarnings.length >= 3) {
    return true;
  }

  return false;
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

  // ── 3. Score with LLM (hybrid: single-shot for clean/obvious, agentic for ambiguous) ─────────────────────
  console.log("  Sending evidence to Gemini for scoring...");
  
  let llmResult;
  let toolCallTranscript: import("./rugcheck-types.js").ToolCallRecord[] | undefined;
  
  // Temporarily disable agentic mode due to Gemini API compatibility issues
  // TODO: Fix Gemini function calling format to use correct API structure
  if (false && isAmbiguous(evidence)) {
    console.log("  Evidence is ambiguous — entering agentic investigation mode...");
    
    const toolContext: ToolContext = {
      client,
      tokenAddress,
      poolAddress,
      deployBlock,
      state: opts?.state,
      ownershipRenounced: evidence.ownershipRenounced,
      ownerAddress: evidence.ownerAddress,
    };
    
    const { result, transcript } = await runAgentLoop(evidence, toolContext, { maxIterations: 12 });
    llmResult = result;
    toolCallTranscript = transcript;
    
    console.log(`  Agentic investigation complete: ${llmResult.ok ? "SUCCESS" : "FAILED"}`);
    if (transcript.length > 0) {
      console.log(`  Tool calls made: ${transcript.length}`);
      for (const call of transcript) {
        console.log(`    - ${call.name} at ${new Date(call.ts).toISOString()}`);
      }
    }
  } 
  
  // Always use single-shot mode for now (agentic mode disabled due to Gemini API compatibility)
  console.log("  Evidence is clear — using single-shot LLM scoring...");
  llmResult = await scoreWithLLM(evidence, opts);

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
      secondaryAdminDetected: evidence.secondaryAdminDetected,
      secondaryAdminSnippet: evidence.secondaryAdminSnippet,
      deployerSeenBefore: evidence.deployerSeenBefore,
      deployerPriorTokens: evidence.deployerPriorTokens,
      flags:   [errorFlag],
      score:   100,
      verdict: "CRITICAL",
      summary: `LLM scoring failed: ${llmResult.reason}`,
      scoringMethod: toolCallTranscript ? "llm-agentic" : "llm",
      scoringError:  llmResult.reason,
      toolCallTranscript,
      analysisId: undefined,
    };
  }

  console.log(`  Gemini verdict: ${llmResult.verdict} (${llmResult.score}/100)`);
  
  // Log tool call transcript if it exists
  if (toolCallTranscript && toolCallTranscript.length > 0) {
    console.log("\n  ── Tool Call Transcript ─────────────────────────────────────");
    for (const call of toolCallTranscript) {
      console.log(`  [${new Date(call.ts).toISOString()}] ${call.name}`);
      console.log(`    Args: ${JSON.stringify(call.args)}`);
      console.log(`    Output: ${JSON.stringify(call.output).slice(0, 200)}${JSON.stringify(call.output).length > 200 ? "..." : ""}`);
    }
    console.log("  ─────────────────────────────────────────────────────────────\n");
  }

  // Store analysis in Upstash if we have agentic data
  let analysisId: string | undefined;
  if (toolCallTranscript && toolCallTranscript.length > 0 && llmResult.ok) {
    try {
      const storedId = await storeAnalysis({
        tokenAddress,
        tokenName: meta.name,
        tokenSymbol: meta.symbol,
        poolAddress,
        pairedAsset,
        score: llmResult.score,
        verdict: llmResult.verdict,
        summary: llmResult.summary,
        evidence,
        toolCallTranscript,
        flags: llmResult.flags,
        scoringMethod: toolCallTranscript ? "llm-agentic" : "llm",
      });
      if (storedId) {
        analysisId = storedId;
        console.log(`  [analysis] Stored analysis with ID: ${analysisId}`);
      }
    } catch (err) {
      console.error(`  [analysis] Failed to store analysis:`, err);
      // Continue without analysis storage - non-critical
    }
  }

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
    secondaryAdminDetected: evidence.secondaryAdminDetected,
    secondaryAdminSnippet: evidence.secondaryAdminSnippet,
    deployerSeenBefore: evidence.deployerSeenBefore,
    deployerPriorTokens: evidence.deployerPriorTokens,
    flags:   llmResult.flags,
    score:   llmResult.score,
    verdict: llmResult.verdict,
    summary: llmResult.summary,
    scoringMethod: toolCallTranscript ? "llm-agentic" : "llm",
    answer:  llmResult.answer,
    toolCallTranscript,
    analysisId,
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
  if (r.secondaryAdminDetected) {
    lines.push(`║  Secondary admin: ⚠️  Detected (ownership shows renounced but privileged role found)`);
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

  // Add analysis link if available (only for agentic scoring)
  if (r.analysisId && r.scoringMethod === "llm-agentic") {
    const frontendBaseUrl = process.env.FRONTEND_BASE_URL;
    if (frontendBaseUrl) {
      lines.push(`🔍 View full agent trace: ${frontendBaseUrl}/analysis/${r.analysisId}`);
    }
  }

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
