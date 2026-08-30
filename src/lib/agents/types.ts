/**
 * agents/types.ts — the contract every specialist in the multi-agent
 * scoring pipeline implements.
 *
 * NOTE: this is a different `types.ts` than the one that used to live here.
 * The old file held FunctionAudit/SourceAuditMethod, which were shared by
 * source-audit.ts and utils/interface.ts and never had anything to do with
 * the scoring pipeline itself — those moved to ../llm-types.ts. This file
 * is now scoped entirely to orchestrator.ts + specialists/*.ts.
 */

import type { TokenEvidence } from "../evidence.js";
import type { RiskFlag } from "../rugcheck-types.js";
import type { ToolContext } from "../utils/interface.js";
import type { ToolCallRecord } from "../rugcheck-types.js";

export interface SpecialistResult {
  agentName: string;
  flags: RiskFlag[];
  toolCallTranscript: ToolCallRecord[];
  /** Non-fatal issues encountered while running this specialist (e.g. the
   *  model returned an empty flags array, or a tool call errored). These
   *  don't fail the whole orchestration — they're surfaced for logging. */
  warnings: string[];
}

export interface SpecialistAgent {
  name: string;
  /** Gate on evidence that's already known before any tool call runs —
   *  e.g. lp-honeypot-agent and trading-activity-agent both require
   *  evidence.hasLiquidity. */
  shouldRun(evidence: TokenEvidence): boolean;
  run(evidence: TokenEvidence, ctx: ToolContext): Promise<SpecialistResult>;
}
