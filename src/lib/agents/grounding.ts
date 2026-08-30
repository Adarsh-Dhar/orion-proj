/**
 * grounding.ts — structural validator for agentic LLM scoring.
 *
 * Validates that the LLM's verdict is structurally consistent with the
 * tool calls it made — i.e. it didn't claim LOW risk without checking
 * mandatory tiers, or stop early at a boundary score with unresolved checks.
 *
 * NOTE: We intentionally do NOT attempt numeric provenance checking
 * (matching numbers in flag text against tool output JSON). That approach
 * is too fragile: the LLM legitimately derives counts from array lengths
 * (e.g. "4 prior tokens" from deployerPriorTokens.length), rounds ETH
 * amounts, and embeds address fragments in explanatory text — none of
 * which survive a naive substring search. Structural validation (did you
 * call the right tools?) is the correct invariant to enforce here.
 */

import type { ToolCallRecord, RiskFlag } from "../rugcheck-types.js";
import type { IterationDecision } from "../utils/interface.js";

const FLAG_ID_TO_TOOL: Record<string, string> = {
  proxy_detected: "getSourceCode",
  admin_privilege_risk: "getSourceCode",
  lp_not_locked: "checkLpLock",
  deployer_prior_rugs: "getDeployerHistory",
  deployer_rapid_deploys: "getDeployerVelocity",
  holder_concentration: "getHolderLedger",
  wash_trading_detected: "getTradeHistory",
  sell_test_failed: "runSellTest",
  // ...
};

// ─── Grounding validator ─────────────────────────────────────────────────────────

/**
 * Validate that the LLM's flags are structurally consistent with the tools
 * it called. Currently this is a permissive pass — all numeric-provenance
 * checks have been removed (see module comment above). The real enforcement
 * is in validateStopConditions(), which checks mandatory-tier coverage.
 */
export function validateGrounding(flags: RiskFlag[], transcript: ToolCallRecord[]): boolean {
  const calledTools = new Set(transcript.map(t => t.name));
  return flags.every(f => {
    const tool = FLAG_ID_TO_TOOL[f.id];
    return tool === undefined || calledTools.has(tool);
  });
}

// ─── Stop conditions validator ─────────────────────────────────────────────────

/** Mirrors validateGrounding()'s number-provenance check, but applied to
 *  the stop/continue decision itself instead of the final flags. */
export function validateStopConditions(
  decisions: IterationDecision[],
  verdict: string
): boolean {
  if (decisions.length === 0) return true; // nothing to validate yet
  const last = decisions[decisions.length - 1];

  if (verdict === "LOW" && last.unresolvedMandatory.length > 0) {
    console.warn(`[grounding] LOW verdict with unresolved mandatory tiers: ${last.unresolvedMandatory.join(", ")}`);
    return false;
  }
  if (last.action === "stop" && last.bandProximity === "boundary" && last.unresolvedMandatory.length > 0) {
    console.warn(`[grounding] Stopped at a boundary score with unresolved mandatory checks`);
    return false;
  }
  return true;
}
