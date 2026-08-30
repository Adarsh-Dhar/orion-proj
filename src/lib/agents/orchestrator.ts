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
import type { SpecialistAgent } from "./types.js";
import { computeScore } from "../scoring.js";
import { validateGrounding, withHardCap, HARD_CAP_MS } from "./grounding.js";
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
  checkLpLock: "lp-honeypot-agent",
  getDeployerHistory: "deployer-reputation-agent",
};

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

  const specialistOutcome = await withHardCap(
    Promise.all(active.map((s) => s.run(evidence, ctx))),
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
  const groundingOk = groundingOutcome;
  if (!groundingOk) {
    return {
      result: { ok: false, reason: "A specialist returned flags not grounded in a tool call it actually made" },
      transcript,
    };
  }

  const calledTools = new Set(transcript.map((t) => t.name));
  const unresolvedMandatory = Object.entries(MANDATORY_TOOL_OWNERS)
    .filter(([, owner]) => activeNames.has(owner))
    .map(([tool]) => tool)
    .filter((tool) => !calledTools.has(tool));

  // Authoritative score/verdict come from scoring.ts's deterministic rule
  // engine, not from any specialist's own math — same principle rugcheck.ts
  // already applies when it overrides the LLM's score after this returns.
  const computed = computeScore(evidence);
  const verdict = unresolvedMandatory.length > 0 ? "INSUFFICIENT" : computed.verdict;

  const summary =
    flags.length > 0
      ? flags[0].detail
      : "No risk factors identified by the specialist agents that ran for this token.";

  const result: LLMScoreResult = {
    ok: true,
    score: computed.score,
    verdict,
    flags,
    summary,
    rawModelText: "",
    toolCallTranscript: transcript,
  };

  return { result, transcript };
}
