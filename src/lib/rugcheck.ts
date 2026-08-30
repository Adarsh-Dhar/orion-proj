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

import { collectMinimalEvidence } from "./evidence.js";
import { scoreWithLLM, answerAboutToken } from "./llm-score.js";
import { computeScore, breakdownToFlags, breakdownToSummary } from "./scoring.js";
import type { TokenEvidence } from "./evidence.js";
import { getDeployerHistory, recordDeployerToken } from "./state.js";
import { runOrchestrator } from "./agents/orchestrator.js";
import type { ToolContext } from "./utils/interface.js";
import { storeAnalysis } from "./analysis-store.js";
import type { Venue } from "./utils/constants.js";

// ─── Re-export shared types ───────────────────────────────────────────────────

import type { RiskLevel, VerdictLevel, RiskFlag, RugCheckResult } from "./rugcheck-types.js";

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
  opts?: {
    userQuestion?: string;
    mode?: "alert" | "chat";
    venue?: Venue;
    /** V4 only: hook contract address from the Initialize event */
    hookAddress?: string | null;
    /** V4 only: PoolKey params for the sell-simulation Quoter call */
    v4PoolParams?: {
      currency0: Address;
      currency1: Address;
      fee: number;
      tickSpacing: number;
      hooks: Address;
    };
    /** Skip expensive checks for faster analysis */
    quickMode?: boolean;
    /** Use efficient sniper-style analysis (recent blocks only) */
    sniperMode?: boolean;
  }
): Promise<RugCheckResult> {

  // ── 2. Collect minimal evidence ───────────────────────────────────────────────
  const evidence: TokenEvidence = await collectMinimalEvidence(
    client, tokenAddress, poolAddress, pairedAsset, deployBlock, meta,
    opts?.venue, opts?.hookAddress, opts?.v4PoolParams
  );

  // ── 3. Update deployer history from persistent state ──────────────────────
  // Since collectMinimalEvidence no longer populates deployer history,
  // we'll handle this via the agent loop's getDeployerHistory tool instead.
  // For now, set defaults that will be updated if the agent runs.
  if (evidence.deployerAddress) {
    const priorTokens = await getDeployerHistory(evidence.deployerAddress);
    evidence.deployerPriorTokens = priorTokens;
    evidence.deployerSeenBefore = priorTokens.length > 0;
    // Record this new token for future deployer-history lookups
    await recordDeployerToken(evidence.deployerAddress, tokenAddress);
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

  // ── 3. Score with LLM (always agentic — no single-shot gate) ─────────────
  console.log("  Sending evidence to Gemini for scoring (agentic)...");

  let llmResult;
  let toolCallTranscript: import("./rugcheck-types.js").ToolCallRecord[] | undefined;
  let decisionTrace: import("./utils/interface.js").IterationDecision[] | undefined;

  const toolContext: ToolContext = {
    client,
    tokenAddress,
    poolAddress,
    deployBlock,
    ownershipRenounced: evidence.ownershipRenounced,
    ownerAddress: evidence.ownerAddress,
    isProxy: evidence.isProxy,
  };

  const { result, transcript } = await runOrchestrator(evidence, toolContext, { maxIterations: 12 });
  llmResult = result;
  toolCallTranscript = transcript;
  decisionTrace = result.ok ? result.decisionTrace : undefined;

  console.log(`  Agentic investigation complete: ${llmResult.ok ? "SUCCESS" : "FAILED"}`);
  if (transcript.length > 0) {
    console.log(`  Tool calls made: ${transcript.length}`);
    for (const call of transcript) {
      console.log(`    - ${call.name} at ${new Date(call.ts).toISOString()}`);
    }
  }

  // Merge holder ledger data from transcript back into evidence
  // The holder-distribution-agent collects this data but it only goes into the transcript
  // We need to update the evidence so the scoring system can use it
  const holderLedgerCall = transcript.find(t => t.name === "getHolderLedger");
  if (holderLedgerCall && typeof holderLedgerCall.output === "object" && holderLedgerCall.output !== null) {
    const output = holderLedgerCall.output as {
      topHolders?: Array<{ address: string; balance: string; pct: number }>;
      scanPartial?: boolean;
      scanFailed?: boolean;
    };
    if (output.topHolders && Array.isArray(output.topHolders)) {
      evidence.top5Holders = output.topHolders.slice(0, 5);
      const totalPct = output.topHolders.slice(0, 5).reduce((sum, h) => sum + h.pct, 0);
      evidence.top5HoldersPct = totalPct > 0 ? totalPct : null;
      
      // Find deployer's balance
      const deployerHolder = output.topHolders.find(h => 
        h.address.toLowerCase() === evidence.deployerAddress?.toLowerCase()
      );
      if (deployerHolder) {
        evidence.deployerCurrentBalance = deployerHolder.balance;
        evidence.deployerPct = deployerHolder.pct;
      }
    }
    if (output.scanPartial !== undefined) {
      evidence.holderScanPartial = output.scanPartial;
    }
    if (output.scanFailed !== undefined) {
      evidence.holderScanFailed = output.scanFailed;
    }
  }

  // If the orchestrator failed outright (missing key, network error, hard-cap
  // timeout, ungrounded-flags rejection) — fall back to single-shot scoring
  // rather than surfacing a hard failure. A working single-shot score beats
  // no score at all. toolCallTranscript is reset to undefined here so the
  // rest of this function (and scoringMethod below) can tell "orchestrator
  // succeeded" apart from "fell back to single-shot" — scoreWithLLM already
  // produces its own `answer` field via opts.userQuestion/opts.mode, so the
  // separate answerAboutToken() step further down is skipped in this case.
  if (!llmResult.ok) {
    console.warn(`  [Agentic] Falling back to single-shot scoring: ${llmResult.reason}`);
    llmResult = await scoreWithLLM(evidence, opts);
    toolCallTranscript = undefined;
  }

  if (!llmResult.ok) {
    console.error(`  [LLM] Scoring failed: ${llmResult.reason}`);
    // IMPORTANT: we no longer force score=100/CRITICAL here. A scoring
    // *failure* is not evidence of risk — faking a 100 made "100" mean
    // "worst token" AND "Gemini timed out" indistinguishably, which both
    // inflated the CRITICAL bucket and hid real outages. Instead we mark
    // this analysis as UNKNOWN and surface the failure explicitly so it's
    // never confused with a genuinely scored CRITICAL token.
    const errorFlag: RiskFlag = {
      id:       "llm_scoring_failed",
      label:    "LLM scoring failed",
      detail:   `Gemini could not score this token: ${llmResult.reason}. This is a scoring failure, not a risk finding.`,
      severity: "MEDIUM",
      points:   0,
    };
    return {
      tokenAddress, poolAddress, pairedAsset, venue: opts?.venue ?? "v3",
      hookAddress: evidence.hookAddress ?? null,
      ownerAddress, ownershipRenounced, isProxy,
      totalSupply, decimals,
      deployerAddress, deployerBalance, deployerBalanceIsEstimate,
      deployerPct: evidence.deployerPct ?? deployerPct,
      top5HoldersPct: evidence.top5HoldersPct ?? top5HoldersPct,
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
      score:   -1,
      verdict: "UNKNOWN",
      summary: `Scoring failed: ${llmResult.reason}`,
      scoringMethod: "failed",
      scoringError:  llmResult.reason,
      toolCallTranscript,
      decisionTrace,
      analysisId: undefined,
    };
  }

  // ── Authoritative score, verdict, flags, and summary ─────────────────────
  // computeScore() is the single source of truth for everything displayed as
  // the judgment. The LLM/agent still drives investigation (tool calls) and
  // may emit a qualitative verdict, but that number was never precise — and
  // keeping the agent's flags/summary while swapping in a different score is
  // how reports ended up saying LOW in the trace and MEDIUM in the header.
  // INSUFFICIENT is the exception: that means mandatory evidence is missing,
  // not that the available evidence scored low, so we must not overwrite it.
  const computed = computeScore(evidence);
  if (llmResult.verdict !== "INSUFFICIENT") {
    if (llmResult.verdict !== computed.verdict || llmResult.score !== computed.score) {
      console.warn(
        `  [score] Agent/LLM ${llmResult.verdict} (${llmResult.score}) overridden by deterministic ${computed.verdict} (${computed.score})`
      );
    }
    llmResult = {
      ...llmResult,
      score:   computed.score,
      verdict: computed.verdict,
      flags:   breakdownToFlags(computed.breakdown, computed.verdict),
      summary: breakdownToSummary(computed.breakdown, computed.verdict, meta.symbol),
    };
  }

  console.log(`  Deterministic score: ${llmResult.verdict} (${llmResult.score}/100)`);
  console.log(`  Score breakdown: ${computed.breakdown.map(b => `${b.id}=${b.contribution}`).join(", ")}`);

  // ── Chat-mode conversational answer ───────────────────────────────────────
  // Only needed for chat mode (alert mode never shows an "answer" field), and
  // only when the orchestrator actually produced this result — the
  // single-shot fallback above already generated its own `answer` via
  // opts.userQuestion/opts.mode, so running this again would be redundant.
  // Runs after the score/verdict/flags/summary above are fully finalized, so
  // the answer is guaranteed to describe the same numbers the report shows.
  const effectiveMode = opts?.mode ?? "chat";
  if (effectiveMode === "chat") {
    if (llmResult.verdict === "INSUFFICIENT") {
      // score is the -1 "no meaningful score" sentinel here. This branch
      // applies regardless of which path produced the result:
      //  - orchestrator path: llmResult.answer isn't set yet at all.
      //  - single-shot fallback path (toolCallTranscript === undefined):
      //    the model already generated its OWN answer as part of the same
      //    JSON response that produced its score — using whatever real
      //    number it picked *before* we normalized score to -1 above. That
      //    stale number can still show up in that prose even though the
      //    card now correctly shows N/A. Overwriting unconditionally here
      //    closes that gap instead of only closing it for one of the two
      //    paths that can reach INSUFFICIENT.
      const last = decisionTrace?.[decisionTrace.length - 1];
      const missing = last?.unresolvedMandatory?.length
        ? ` (still missing: ${last.unresolvedMandatory.join(", ")})` 
        : "";
      llmResult = {
        ...llmResult,
        answer: `There isn't enough verified evidence yet to give this token a reliable risk score${missing}. The flags below reflect what's been checked so far, but treat this as incomplete, not clean.`,
      };
    } else if (toolCallTranscript !== undefined) {
      // Only regenerate via a fresh call for the orchestrator path — the
      // single-shot fallback already produced its own answer in the same
      // call that produced its (non-INSUFFICIENT, so trustworthy) score,
      // so re-running this here would be redundant.
      const answer = await answerAboutToken(
        evidence,
        { score: llmResult.score, verdict: llmResult.verdict, flags: llmResult.flags, summary: llmResult.summary },
        opts?.userQuestion
      );
      if (answer) {
        llmResult = { ...llmResult, answer };
      }
    }
  }

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

  // Store analysis in Upstash for every successful scoring run — not just
  // agentic ones — so the frontend link works with single-shot results too.
  let analysisId: string | undefined;
  if (llmResult.ok) {
    try {
      const storedId = await storeAnalysis({
        tokenAddress,
        tokenName: meta.name,
        tokenSymbol: meta.symbol,
        poolAddress,
        pairedAsset,
        venue:       opts?.venue ?? "v3",
        hookAddress: evidence.hookAddress ?? null,
        score: llmResult.score,
        verdict: llmResult.verdict,
        summary: llmResult.summary,
        evidence,
        toolCallTranscript, // undefined for single-shot runs — storage handles that gracefully
        decisionTrace, // undefined for single-shot runs — storage handles that gracefully
        flags: llmResult.flags,
        scoringMethod: toolCallTranscript ? "llm-agentic" : "llm",
        scoreBreakdown: computed.breakdown,
      });
      if (storedId) {
        analysisId = storedId;
        console.log(`  [analysis] Stored analysis with ID: ${analysisId}`);
      }
    } catch (err) {
      console.error(`  [analysis] Failed to store analysis:`, err);
      // Non-critical — scoring result is still returned
    }
  }

  return {
    tokenAddress, poolAddress, pairedAsset, venue: opts?.venue ?? "v3",
    hookAddress: evidence.hookAddress ?? null,
    ownerAddress, ownershipRenounced, isProxy,
    totalSupply, decimals,
    deployerAddress, deployerBalance, deployerBalanceIsEstimate,
    deployerPct: evidence.deployerPct ?? deployerPct,
    top5HoldersPct: evidence.top5HoldersPct ?? top5HoldersPct,
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
    decisionTrace,
    analysisId,
  };
}

// ─── Report formatter ─────────────────────────────────────────────────────────

const VERDICT_EMOJI:  Record<VerdictLevel, string> = { LOW: "🟢", MEDIUM: "🟡", HIGH: "🟠", CRITICAL: "🔴", UNKNOWN: "⚪", INSUFFICIENT: "⚪" };
const SEVERITY_EMOJI: Record<RiskLevel, string> = { LOW: "🟢", MEDIUM: "🟡", HIGH: "🟠", CRITICAL: "🔴" };

function formatScore(score: number): string {
  return score < 0 ? "N/A" : `${score.toFixed(2)}/100`;
}

export function formatRugReport(
  r: RugCheckResult,
  meta: { name: string; symbol: string; totalSupplyFormatted: string }
): string {
  const lines: string[] = [];
  const v = VERDICT_EMOJI[r.verdict];
  const scoredBy = (r.scoringMethod === "llm" || r.scoringMethod === "llm-agentic")
    ? `LLM (Gemini)${r.scoringMethod === "llm-agentic" ? " + agent" : ""}${r.scoringError ? " — SCORING FAILED, see flags" : ""}`
    : "rule engine";

  lines.push(`╔══ RUG CHECK REPORT ════════════════════════════════════════════`);
  lines.push(`║  Token    : ${meta.name} (${meta.symbol})`);
  lines.push(`║  Address  : ${r.tokenAddress}`);
  lines.push(`║  Pool     : ${r.poolAddress}`);
  lines.push(`║  Venue    : ${r.venue === "v4" ? "Uniswap V4" : "Uniswap V3"}`);
  if (r.venue === "v4" && r.hookAddress) {
    const nullHook = "0x0000000000000000000000000000000000000000";
    lines.push(`║  Hook     : ${r.hookAddress === nullHook ? "None (0x0)" : `⚠️  ${r.hookAddress}`}`);
  }
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
  lines.push(`║  Score    : ${formatScore(r.score)}`);
  lines.push(`║  Verdict  : ${v} ${r.verdict}`);
  lines.push(`║  Summary  : ${r.summary}`);
  
  const last = r.decisionTrace?.[r.decisionTrace.length - 1];
  if (last) {
    // Never echo last.reason here — it is the agent's own (possibly discarded)
    // stop sentence, e.g. "Emitting LOW verdict", and must not sit next to a
    // deterministic MEDIUM/HIGH/CRITICAL score. Surface investigation coverage
    // only; the flags + summary above already explain the displayed number.
    if (r.verdict === "INSUFFICIENT") {
      lines.push(`║  ⚪ Insufficient data — still missing: ${last.unresolvedMandatory.join(", ")}`);
    } else if (last.unresolvedMandatory.length === 0) {
      lines.push(`║  📊 All mandatory tiers checked`);
    } else {
      lines.push(`║  📊 Score from collected evidence; still missing: ${last.unresolvedMandatory.join(", ")}`);
    }
  }
  
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

  const venueTag = r.venue === "v4" ? " · V4" : " · V3";
  lines.push(`${v} ${r.verdict} — ${meta.name} ($${meta.symbol})  ·  ${formatScore(r.score)}${venueTag}`);
  lines.push(r.summary);

  const last = r.decisionTrace?.[r.decisionTrace.length - 1];
  if (last && r.verdict === "INSUFFICIENT") {
    lines.push(`⚪ Still missing: ${last.unresolvedMandatory.join(", ")}`);
  }

  const topFlags = [...r.flags].sort((a, b) => b.points - a.points).slice(0, 2);
  for (const f of topFlags) {
    lines.push(`${SEVERITY_EMOJI[f.severity]} ${f.label}`);
  }

  // Surface non-zero hook address for V4 pools — this is a key trust signal
  if (r.venue === "v4" && r.hookAddress && r.hookAddress !== "0x0000000000000000000000000000000000000000") {
    lines.push(`🪝 Hook: ${r.hookAddress}`);
  }

  lines.push(r.tokenAddress);
  lines.push(`https://basescan.org/address/${r.tokenAddress}`);

  // Add analysis link if available — shown for all scoring methods, not just agentic
  if (r.analysisId) {
    const frontendBaseUrl = process.env.FRONTEND_BASE_URL;
    if (frontendBaseUrl) {
      lines.push(`🔍 View full report: ${frontendBaseUrl}/analysis/${r.analysisId}`);
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

  const venueTag = r.venue === "v4" ? " · V4" : " · V3";
  lines.push(`${v} ${r.verdict}  ·  ${formatScore(r.score)}  ·  ${meta.name} ($${meta.symbol})${venueTag}`);

  const topFlags = [...r.flags].sort((a, b) => b.points - a.points).slice(0, 3);
  if (topFlags.length > 0) {
    lines.push("");
    for (const f of topFlags) lines.push(`${SEVERITY_EMOJI[f.severity]} ${f.label} — ${f.detail}`);
  }

  if (r.venue === "v4" && r.hookAddress && r.hookAddress !== "0x0000000000000000000000000000000000000000") {
    lines.push("", `🪝 V4 Hook: ${r.hookAddress}`);
  }

  lines.push("", r.tokenAddress, `Send /full ${r.tokenAddress} for the complete report.`);
  return lines.join("\n");
}