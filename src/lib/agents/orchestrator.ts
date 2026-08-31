/**
 * agents/orchestrator.ts — replaces agent-loop.ts.
 *
 * No LLM call of its own for the "plan" step — that's just a filter over
 * SPECIALISTS.filter(s => s.shouldRun(evidence)). Dispatches the filtered
 * specialists with Promise.all, merges their flags/transcript/warnings,
 * computes score/verdict by reusing scoring.ts's deterministic weighting
 * (rather than trusting free-form LLM math the way the old single-agent
 * loop did), then hands the merged flags to validateGrounding from
 * grounding.ts (which now uses a critic LLM with tools to verify each
 * flag's factual grounding, not just structural tool-call presence).
 *
 * Call-site shape is unchanged from runAgentLoop: same (evidence, ctx, opts)
 * input, same { result, transcript } output — rugcheck.ts's call site only
 * needed a name swap.
 */

import type { TokenEvidence } from "../evidence.js";
import type { ToolContext } from "../utils/interface.js";
import type { LLMScoreResult, RiskFlag, ToolCallRecord } from "../rugcheck-types.js";
import type { SpecialistAgent, SpecialistResult } from "./types.js";
import { computeScore } from "../scoring.js";
import { validateGrounding, withHardCap, HARD_CAP_MS, type GroundingResult } from "./grounding.js";
import {
  sourceOwnerAgent,
  deployerReputationAgent,
  holderDistributionAgent,
  lpHoneypotAgent,
  tradingActivityAgent,
} from "./specialists/index.js";
import { GEMINI_API_KEY } from "../gemini-client.js";

const SPECIALISTS: SpecialistAgent[] = [
  sourceOwnerAgent,
  deployerReputationAgent,
  holderDistributionAgent,
  lpHoneypotAgent,
  tradingActivityAgent,
];

/** Which specialist owns each mandatory tier, so we only count a tier as
 *  unresolved when the specialist that owns it actually ran (per its own
 *  shouldRun gate) and still never called the tool — mirrors the intent of
 *  agent-loop.ts's MANDATORY_TIERS check without penalizing a specialist
 *  that correctly sat out (e.g. lp-honeypot-agent when hasLiquidity=false). */
const MANDATORY_TOOL_OWNERS: Record<string, string> = {
  getSourceCode: "source-owner-agent",
  getDeployerHistory: "deployer-reputation-agent",
};
// checkLpLock removed: the tool it referred to no longer exists
// (checkLpLockStatus was deleted along with the other historical-scan
// stubs). lp-honeypot-agent still runs and still scores lpPositionStatus,
// it just no longer has a mandatory tool call to satisfy.

/** Flag ids/labels that specifically claim the *deployer's own* wallet holds
 *  a large share of supply — the highest-severity holder-concentration
 *  claim (+40 CRITICAL / +20 HIGH per the scoring guide). This is the exact
 *  claim that misfired for a real token: a specialist labeled a top-5-holder
 *  concentration finding as a dev-wallet finding, and the grounding critic
 *  approved it anyway. Rather than trust LLM judgment alone for a check this
 *  cheap to do deterministically, cross-verify any such flag against
 *  evidence.deployerPct — the actual field the claim is supposed to describe
 *  — before it ever reaches the user. */
const DEV_WALLET_FLAG_PATTERN = /dev[_\s-]?wallet/i;

/**
 * Deterministic backstop on top of the LLM grounding critic: drop any flag
 * that specifically claims the *deployer's* wallet holds a large share of
 * supply when evidence.deployerPct doesn't actually support that (a
 * top-5-holder concentration finding is a real, different, lower-severity
 * claim — see holder-distribution-agent's scoring guide). The critic is
 * supposed to catch this class of mislabeling and sometimes doesn't; this
 * check can't be fooled by LLM reasoning because it never asks an LLM
 * anything — it just reads the one evidence field the claim is about.
 */
function sanityCheckFlags(flags: RiskFlag[], evidence: TokenEvidence): { flags: RiskFlag[]; dropped: Array<{ id: string; reason: string }> } {
  const kept: RiskFlag[] = [];
  const dropped: Array<{ id: string; reason: string }> = [];

  for (const flag of flags) {
    const claimsDevWallet = DEV_WALLET_FLAG_PATTERN.test(flag.id) || DEV_WALLET_FLAG_PATTERN.test(flag.label);
    if (claimsDevWallet) {
      const pct = evidence.deployerPct;
      const requiredPct = flag.severity === "CRITICAL" ? 50 : flag.severity === "HIGH" ? 20 : 0;
      if (pct === null || pct < requiredPct) {
        dropped.push({
          id: flag.id,
          reason: `claims dev wallet holds ${requiredPct}%+ but evidence.deployerPct is ${pct === null ? "null (unverified)" : `${pct}%`}`,
        });
        continue;
      }
    }
    kept.push(flag);
  }

  return { flags: kept, dropped };
}

export interface AgentLoopResult {
  result: LLMScoreResult;
  transcript: ToolCallRecord[];
}

export async function runOrchestrator(
  evidence: TokenEvidence,
  ctx: ToolContext,
  _opts: { maxIterations?: number } = {}
): Promise<AgentLoopResult> {
  if (!GEMINI_API_KEY) {
    return { result: { ok: false, reason: "GEMINI_API_KEY is not set" }, transcript: [] };
  }

  const startedAt = Date.now();

  const active = SPECIALISTS.filter((s) => s.shouldRun(evidence));
  const activeNames = new Set(active.map((s) => s.name));

  // Add individual timeout per specialist (5 minutes each) to prevent
  // one slow specialist from blocking the entire Promise.all
  const SPECIALIST_TIMEOUT_MS = 5 * 60_000; // 5 minutes per specialist
  const specialistsWithTimeout = active.map((s) =>
    Promise.race([
      s.run(evidence, ctx),
      new Promise<SpecialistResult>((_, reject) =>
        setTimeout(() => reject(new Error(`Specialist ${s.name} exceeded ${SPECIALIST_TIMEOUT_MS / 60_000}m timeout`)), SPECIALIST_TIMEOUT_MS)
      ),
    ]).catch((err) => {
      // If a specialist times out or fails, return a failure result
      // instead of letting the entire Promise.all fail
      console.warn(`  [orchestrator] Specialist ${s.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        agentName: s.name,
        flags: [],
        toolCallTranscript: [],
        warnings: [`Specialist ${s.name} failed: ${err instanceof Error ? err.message : String(err)}`],
      };
    })
  );

  const specialistOutcome = await withHardCap(
    Promise.all(specialistsWithTimeout),
    startedAt
  );
  if (specialistOutcome === "TIMEOUT") {
    return {
      result: { ok: false, reason: `Specialist dispatch exceeded the ${HARD_CAP_MS / 3_600_000}h hard cap` },
      transcript: [],
    };
  }
  const results = specialistOutcome;

  const flags: RiskFlag[] = [];
  const transcript: ToolCallRecord[] = [];
  const specialistWarnings: string[] = [];
  for (const r of results) {
    flags.push(...r.flags);
    transcript.push(...r.toolCallTranscript);
    specialistWarnings.push(...r.warnings);
  }

  if (specialistWarnings.length > 0) {
    console.warn(`  [orchestrator] specialist warnings:\n    ${specialistWarnings.join("\n    ")}`);
  }

  const groundingOutcome = await withHardCap(validateGrounding(flags, transcript, evidence), startedAt);
  if (groundingOutcome === "TIMEOUT") {
    return {
      result: { ok: false, reason: `Grounding critic exceeded the ${HARD_CAP_MS / 3_600_000}h hard cap` },
      transcript,
    };
  }
  if (!groundingOutcome.ok) {
    return {
      result: { ok: false, reason: "Grounding critic failed to produce a verdict for this scan" },
      transcript,
    };
  }
  if (groundingOutcome.dropped.length > 0) {
    console.warn(`[orchestrator] dropped ${groundingOutcome.dropped.length} ungrounded flag(s): ${groundingOutcome.dropped.map(d => `${d.id} (${d.reason})`).join(", ")}`);
  }
  // Replace flags with the filtered, grounded list
  flags.length = 0;
  flags.push(...groundingOutcome.groundedFlags);

  // Deterministic backstop, independent of the LLM critic above — see
  // sanityCheckFlags for why this class of error needs one.
  const sanityOutcome = sanityCheckFlags(flags, evidence);
  if (sanityOutcome.dropped.length > 0) {
    console.warn(
      `[orchestrator] sanity check dropped ${sanityOutcome.dropped.length} flag(s): ` +
      sanityOutcome.dropped.map(d => `${d.id} (${d.reason})`).join(", ")
    );
  }
  flags.length = 0;
  flags.push(...sanityOutcome.flags);

  const calledTools = new Set(transcript.map((t) => t.name));
  const unresolvedMandatory = Object.entries(MANDATORY_TOOL_OWNERS)
    .filter(([, owner]) => activeNames.has(owner))
    .map(([tool]) => tool)
    .filter((tool) => !calledTools.has(tool));

  // Authoritative score/verdict come from scoring.ts's deterministic rule
  // engine, not from any specialist's own math — same principle rugcheck.ts
  // already applies when it overrides the LLM's score after this returns.
  const computed = computeScore(evidence);
  const insufficient = unresolvedMandatory.length > 0;
  const verdict = insufficient ? "INSUFFICIENT" : computed.verdict;
  const score = insufficient ? -1 : computed.score;   // -1 = existing "no score" sentinel

  const summary =
    flags.length > 0
      ? flags[0].detail
      : "No risk factors identified by the specialist agents that ran for this token.";

  const result: LLMScoreResult = {
    ok: true,
    score,
    verdict,
    flags,
    summary,
    rawModelText: "",
    toolCallTranscript: transcript,
  };

  return { result, transcript };
}
