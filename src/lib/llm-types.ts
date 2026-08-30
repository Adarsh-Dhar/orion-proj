/**
 * llm-types.ts — shared types produced by the LLM-powered source audit.
 *
 * Moved out of agents/ because these are consumed by evidence.ts and
 * utils/interface.ts, not just by code living under agents/ — they aren't
 * part of the multi-agent scoring pipeline's own contract (see
 * agents/types.ts for that).
 */

/**
 * A single function-level (or modifier-level) finding from the source-audit
 * agent. This is the LLM-produced analogue of what checkSourceVerification()
 * used to build purely from SUSPICIOUS_SOURCE_KEYWORDS string matches.
 */
export interface FunctionAudit {
  /** Function or modifier name as it appears in source. */
  name: string;
  /** Step 1 of the rubric: what the code mechanically does, in plain terms. */
  mechanicalEffect: string;
  /** Step 2: who can call it / what gates execution (owner-only, public, role-gated, ungated). */
  accessControl: string;
  /** Step 3: concrete effect on a normal trader/holder if this path executes. */
  userImpact: string;
  /** Step 4: which known benign/malicious pattern this resembles, or "novel". */
  precedentMatch: string;
  /** Final judgment. */
  suspicious: boolean;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  /** Model's self-reported confidence in this specific verdict, 0–1. */
  confidence: number;
  /** One-paragraph justification tying steps 1–4 to the verdict. */
  reasoning: string;
  /** Source snippet the verdict is based on (already truncated by the caller). */
  snippet: string;
  /** True only if ownership is renounced AND this function is gated by a
   *  separate, non-owner privileged address — a hidden secondary admin. */
  secondaryAdminCandidate: boolean;
}

/** Which path produced a given source-audit result — used for logging/debugging.
 *  There is no keyword-fallback path: analyzeSourceWithLLM throws on failure
 *  rather than ever returning a result with a weaker provenance. */
export type SourceAuditMethod = "llm";
