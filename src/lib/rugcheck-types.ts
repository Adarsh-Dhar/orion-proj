/**
 * rugcheck-types.ts — canonical home for the small set of enum-like types
 * shared across evidence collection, scoring, and the agents/ folder.
 *
 * NOTE: this file was missing from the last export of the project (it isn't
 * referenced anywhere as being intentionally deleted, and ~10 other files
 * still import from it) which is why the project failed to compile. Values
 * below are reconstructed from how each type is used at every call site
 * (verdictFor() in scoring.ts, the "v3"/"v4" venue branches in evidence.ts,
 * the verdict === "UNKNOWN" fallback in rugcheck.ts, etc.) — nothing here is
 * new behavior, it restores what every other file already assumed existed.
 *
 * Larger, single-owner shapes (RiskFlag, ToolCallRecord, RugCheckResult,
 * LLMScoreResult, StoredAnalysis, ...) are NOT re-declared here — they are
 * already fully defined in ./utils/interface.ts and that remains their one
 * canonical definition. Re-exported below for convenience so existing
 * `from "./rugcheck-types.js"` imports keep working without touching every
 * call site.
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Same buckets as RiskLevel, plus "UNKNOWN" for when scoring itself failed
 *  (score is set to -1 in that case — see RugCheckResult.score).
 *  INSUFFICIENT means the LLM call succeeded but mandatory-tier evidence was
 *  still unresolved when the iteration budget ran out — a real audit outcome,
 *  not a technical failure. */
export type VerdictLevel = RiskLevel | "UNKNOWN" | "INSUFFICIENT";

/** Which Uniswap architecture the pool being analyzed lives on. */
export type Venue = "v3" | "v4";

export type {
  RiskFlag,
  ToolCallRecord,
  RugCheckResult,
  LLMScoreResult,
  LLMScoreSuccess,
  LLMScoreFailure,
  IterationDecision,
} from "./utils/interface.js";