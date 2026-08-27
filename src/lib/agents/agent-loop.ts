/**
 * agent-loop.ts — controller for the agentic LLM scoring loop.
 *
 * Orchestrates the agentic scoring process, including the loop controller,
 * budget cap, and integration with the grounding validator.
 */

import type { TokenEvidence } from "../evidence.js";
import type { LLMScoreResult } from "./llm-score.js";
import type { ToolCallRecord } from "../rugcheck-types.js";
import type { ToolContext, IterationDecision } from "../utils/interface.js";
// IterationDecision is used only for the decisions[] array type — scoreWithLLMAgentic
// owns pushing to it; agent-loop.ts reads it for post-loop validation only.
import { scoreWithLLMAgentic } from "./llm-score.js";
import { AGENT_TOOLS, dispatchTool } from "./agent-tools.js";
import { validateGrounding, validateStopConditions } from "./grounding.js";

// ─── Main loop controller ───────────────────────────────────────────────────────

export interface AgentLoopResult {
  result: LLMScoreResult;
  transcript: ToolCallRecord[];
}

export async function runAgentLoop(
  evidence: TokenEvidence,
  ctx: ToolContext,
  opts: { maxIterations?: number }
): Promise<AgentLoopResult> {
  const maxIter = opts.maxIterations ?? 12;
  const decisions: IterationDecision[] = [];
  const MANDATORY_TIERS = ["getSourceCode", "checkLpLock", "getDeployerHistory"];
  const resolvedTiers = new Set<string>();

  // scoreWithLLMAgentic owns the decisions[] array — it pushes model-parsed
  // IterationDecision objects from _reportDecision calls. This dispatcher only
  // needs to unwrap the tool output and track which real tools were called.
  const toolDispatcher = async (name: string, args: Record<string, unknown>) => {
    const result = await dispatchTool(name, args, ctx);
    resolvedTiers.add(name);
    // dispatchTool returns { output, decision }; we only need output here.
    if (typeof result === "object" && result !== null && "output" in result) {
      return (result as { output: unknown }).output;
    }
    return result as unknown;
  };

  const llmResult = await scoreWithLLMAgentic(
    evidence,
    toolDispatcher,
    AGENT_TOOLS,
    { maxIterations: maxIter, decisions, mandatoryTiers: MANDATORY_TIERS }
  );

  // Budget exhausted with mandatory coverage incomplete → INSUFFICIENT,
  // never force a LOW/MEDIUM score on incomplete evidence
  const unresolved = MANDATORY_TIERS.filter(t => !resolvedTiers.has(t));
  if (llmResult.ok && unresolved.length > 0 && decisions.length >= maxIter) {
    return {
      result: { ...llmResult, verdict: "INSUFFICIENT" },
      transcript: llmResult.toolCallTranscript ?? [],
    };
  }

  const transcript = llmResult.ok ? (llmResult.toolCallTranscript ?? []) : [];

  // If LLM failed, return the failure with the transcript
  if (!llmResult.ok) {
    return {
      result: llmResult,
      transcript,
    };
  }

  // Validate grounding for successful results
  const groundingOk = validateGrounding(llmResult.flags, transcript);
  const stopConditionsOk = validateStopConditions(decisions, llmResult.ok ? llmResult.verdict : "UNKNOWN");
  if (!groundingOk || !stopConditionsOk) {
    return {
      result: { ok: false, reason: groundingOk ? "Unjustified stop/continue decision" : "LLM returned flags with ungrounded numeric facts" },
      transcript,
    };
  }

  return {
    result: llmResult,
    transcript,
  };
}
