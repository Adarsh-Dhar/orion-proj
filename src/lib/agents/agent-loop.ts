/**
 * agent-loop.ts — controller for the agentic LLM scoring loop.
 *
 * DEPRECATED: This file was replaced by orchestrator.ts during the multi-agent specialist pipeline refactor.
 * No other files import from this file, so it appears to be dead code.
 * Keeping it for reference in case it needs to be resurrected.
 */

import type { TokenEvidence } from "../evidence.js";
import type { LLMScoreResult } from "../llm-score.js";
import type { ToolCallRecord } from "../rugcheck-types.js";
import type { ToolContext } from "../utils/interface.js";

export interface AgentLoopResult {
  result: LLMScoreResult;
  transcript: ToolCallRecord[];
}

export async function runAgentLoop(
  _evidence: TokenEvidence,
  _ctx: ToolContext,
  _opts: { maxIterations?: number }
): Promise<AgentLoopResult> {
  throw new Error("agent-loop.ts is deprecated - use orchestrator.ts instead");
}
