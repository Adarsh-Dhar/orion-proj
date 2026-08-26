/**
 * agent-loop.ts — controller for the agentic LLM scoring loop.
 *
 * Orchestrates the agentic scoring process, including the loop controller,
 * budget cap, and integration with the grounding validator.
 */

import type { TokenEvidence } from "./evidence.js";
import type { LLMScoreResult, ToolCallRecord } from "./llm-score.js";
import type { ToolContext, AgentLoopResult } from "./utils/interface.js";
import { scoreWithLLMAgentic } from "./llm-score.js";
import { AGENT_TOOLS, dispatchTool } from "./agent-tools.js";
import { validateGrounding } from "./grounding.js";

// ─── Main loop controller ───────────────────────────────────────────────────────


export async function runAgentLoop(
  evidence: TokenEvidence,
  ctx: ToolContext,
  opts: { maxIterations?: number }
): Promise<AgentLoopResult> {
  const maxIter = opts.maxIterations ?? 12;

  // Create a tool dispatcher that has access to the context
  const toolDispatcher = async (name: string, args: Record<string, unknown>) => {
    return dispatchTool(name, args, ctx);
  };

  // Run the agentic LLM scoring
  const llmResult = await scoreWithLLMAgentic(
    evidence,
    toolDispatcher,
    AGENT_TOOLS,
    { maxIterations: maxIter }
  );

  // Extract transcript from the result
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
  if (!groundingOk) {
    return {
      result: {
        ok: false,
        reason: "LLM returned flags with ungrounded numeric facts",
      },
      transcript,
    };
  }

  return {
    result: llmResult,
    transcript,
  };
}
