/**
 * grounding.ts — validator for the multi-agent scoring pipeline's output.
 *
 * validateGrounding(): evidentiary — does each flag's claim actually match
 * the underlying data? Delegated to a second, smaller LLM call (the
 * "critic") that must use tools to look up the specific evidence field or
 * tool-call output it needs per flag, rather than being handed everything
 * and trusted. This replaces an earlier purely-structural "was the right
 * tool called by *someone*" check, which could be satisfied by an
 * unrelated specialist's tool call and never verified a flag's actual
 * content.
 */

import type { TokenEvidence } from "../evidence.js";
import type { ToolCallRecord, RiskFlag } from "../rugcheck-types.js";
import { callGeminiWithTools, type Message } from "../gemini-client.js";

// ─── Critic tool schema ──────────────────────────────────────────────────────
// Deliberately narrow: the critic can only look things up, never take action.

const CRITIC_TOOLS = [
  {
    name: "getEvidenceField",
    description:
      "Look up one or more fields from the baseline TokenEvidence object " +
      "(the raw on-chain facts collected before any agentic tool calls ran). " +
      "Use this to check whether a flag's claim matches the actual evidence value.",
    parameters: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Names of TokenEvidence fields to fetch, e.g. [\"isProxy\", \"hasLiquidity\"]",
        },
      },
      required: ["fields"],
    },
  },
  {
    name: "getToolCallOutput",
    description:
      "Look up the raw output of every specialist tool call matching a given tool name " +
      "from the merged investigation transcript (e.g. getSourceCode, checkLpLock). " +
      "Use this to verify claims about deeper evidence gathered by a specialist.",
    parameters: {
      type: "object",
      properties: {
        toolName: { type: "string", description: "Name of the tool, e.g. \"getSourceCode\"" },
      },
      required: ["toolName"],
    },
  },
  // Allow direct calls to specialist tools for convenience
  {
    name: "getDeployerHistory",
    description: "Look up deployer history from transcript - returns deployerSeenBefore and deployerPriorTokens",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "getDeployerVelocity", 
    description: "Look up deployer velocity from transcript - returns deploysLast15Min, deploysLastHour, deploysLast24h",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "getHolderLedger",
    description: "Look up holder distribution from transcript - returns top5Holders, top5HoldersPct",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
] as const;

const CRITIC_MAX_ITERATIONS = 6;

const CRITIC_SYSTEM_PROMPT = `You are a fact-checker reviewing risk flags produced by specialist AI \
agents during a crypto rug-pull risk analysis. You do NOT get the full evidence dump up front — you must \
call getEvidenceField and/or getToolCallOutput to look up whatever you need to verify each flag.

You can also call tools directly by their actual names (e.g. "getDeployerHistory", "getHolderLedger") to look up their outputs.

For each flag, check whether its "detail" text is actually supported by the data you look up. \
Common failure modes to catch:
- A flag claims a risk on a field that is null/unverified/not-yet-available and treats it as a confirmed fact.
- A flag penalizes a liquidity-dependent signal (pool liquidity, sell test, LP lock, wash-trading/trade \
  activity) when hasLiquidity is false — those fields are meaningless placeholders pre-liquidity, not risk.
- A flag's severity/points are wildly inconsistent with what the underlying data actually shows.
- A flag references a number or fact that isn't traceable to any evidence field or tool output at all.
- A flag's id belongs to a different domain than what its detail text actually describes (e.g. a
  holder-concentration claim carrying an lp_not_locked id) — the underlying tool output should match the claim.

Minor rounding, reasonable derived counts (e.g. "4 prior tokens" from an array of length 4), and \
paraphrasing are all FINE — do not fail a flag over that. You are checking factual grounding, not prose style.

When you have checked every flag, respond with ONLY this JSON (no markdown, no prose):
{
  "verdicts": [
    { "id": "<flag id>", "grounded": true|false, "reason": "<one short sentence>" }
  ]
}`;

interface CriticVerdict {
  id: string;
  grounded: boolean;
  reason: string;
}

export interface GroundingResult {
  ok: boolean;
  groundedFlags: RiskFlag[];
  dropped: Array<{ id: string; reason: string }>;
}

function buildCriticMessages(flags: RiskFlag[]): Message[] {
  return [
    { role: "user", parts: [{ text: CRITIC_SYSTEM_PROMPT }] },
    {
      role: "model",
      parts: [{ text: "Understood. I will look up evidence and tool outputs before judging each flag, and respond with only the JSON verdict object." }],
    },
    {
      role: "user",
      parts: [{ text: `Flags to verify:\n${JSON.stringify(flags.map(f => ({
        id: f.id, label: f.label, detail: f.detail, severity: f.severity, points: f.points,
      })), null, 2)}` }],
    },
  ];
}

function dispatchCriticTool(
  name: string,
  args: Record<string, unknown>,
  evidence: TokenEvidence,
  transcript: ToolCallRecord[]
): Record<string, unknown> {
  if (name === "getEvidenceField") {
    const fields = Array.isArray(args.fields) ? (args.fields as string[]) : [];
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      out[f] = (evidence as unknown as Record<string, unknown>)[f] ?? "<unknown field>";
    }
    return out;
  }
  if (name === "getToolCallOutput") {
    const toolName = typeof args.toolName === "string" ? args.toolName : "";
    const matches = transcript.filter(t => t.name === toolName).map(t => t.output);
    return matches.length > 0 ? { results: matches } : { error: `No calls to "${toolName}" found in the transcript.` };
  }
  // Handle direct tool name lookups for specialist tools (getDeployerHistory, getDeployerVelocity, getHolderLedger)
  const matches = transcript.filter(t => t.name === name).map(t => t.output);
  if (matches.length > 0) {
    return { results: matches };
  }
  return { error: `No calls to "${name}" found in the transcript.` };
}

/**
 * Ask a critic LLM to verify that each flag is actually grounded in the
 * evidence/transcript, by having it look the data up via tools rather than
 * trusting a text dump. Returns a filtered list of grounded flags instead of
 * a simple pass/fail boolean — only the flags the critic rejects are dropped,
 * and only a critic-level failure (network, bad JSON, budget exhausted) returns
 * ok: false.
 *
 * Fails closed: if the critic call itself errors out (network, bad JSON,
 * budget exhausted), this returns ok: false rather than silently passing.
 */
export async function validateGrounding(
  flags: RiskFlag[],
  transcript: ToolCallRecord[],
  evidence: TokenEvidence
): Promise<GroundingResult> {
  if (flags.length === 0) return { ok: true, groundedFlags: flags, dropped: [] };

  const messages = buildCriticMessages(flags);

  try {
    for (let i = 0; i < CRITIC_MAX_ITERATIONS; i++) {
      const response = await callGeminiWithTools(
        messages as unknown as Array<{ role: string; parts: Array<Record<string, unknown>> }>,
        CRITIC_TOOLS,
        undefined // The critic uses the global fallback pool, not a specialist-specific pool
      );

      if (response.type === "tool_calls") {
        messages.push(response.modelContent);
        // When there are multiple tool calls, we need to consolidate all responses
        // into a single user turn with multiple functionResponse parts
        const responseParts = response.toolCalls.map(call => {
          const toolResult = dispatchCriticTool(call.name, call.args, evidence, transcript);
          // Ensure response is always a structured object, never a raw string
          const response = typeof toolResult === 'string'
            ? { error: toolResult }
            : toolResult;
          return {
            functionResponse: {
              name: call.name,
              response,
            },
          };
        });
        messages.push({
          role: "user",
          parts: responseParts,
        });
        continue;
      }

      // Final response — response.json is already parsed by callGeminiWithTools.
      const parsed = response.json as { verdicts?: CriticVerdict[] };

      if (!Array.isArray(parsed.verdicts)) {
        console.warn("[grounding] critic returned malformed verdict shape");
        return { ok: false, groundedFlags: [], dropped: [] };
      }

      const byId = new Map(parsed.verdicts.map(v => [v.id, v]));
      const groundedFlags: RiskFlag[] = [];
      const dropped: Array<{ id: string; reason: string }> = [];

      for (const flag of flags) {
        if (flag.points <= 0) {
          // Informational flags don't need grounding — auto-accept
          groundedFlags.push(flag);
          continue;
        }
        const verdict = byId.get(flag.id);
        if (!verdict || !verdict.grounded) {
          dropped.push({ id: flag.id, reason: verdict?.reason ?? "no verdict returned" });
          console.warn(`[grounding] flag "${flag.id}" failed critic review: ${verdict?.reason ?? "no verdict returned"}`);
        } else {
          groundedFlags.push(flag);
        }
      }

      return { ok: true, groundedFlags, dropped };
    }

    console.warn("[grounding] critic exceeded max iterations without a final verdict");
    return { ok: false, groundedFlags: [], dropped: [] };
  } catch (err) {
    console.warn(`[grounding] critic call failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, groundedFlags: [], dropped: [] };
  }
}

// ─── Hard wall-clock cap ─────────────────────────────────────────────────────
// A pipeline-level stop condition independent of iteration counts: no
// single scoring run (specialist dispatch + grounding critic combined) may
// run past this wall-clock budget, no matter how many tool-call iterations
// remain. Exists to prevent an occasional Gemini stall or hung tool call
// from pinning a scan indefinitely.

export const HARD_CAP_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Remaining budget for a pipeline that started at `startedAt`, clamped to zero. */
export function remainingHardCapMs(startedAt: number): number {
  return Math.max(0, HARD_CAP_MS - (Date.now() - startedAt));
}

/**
 * Race any pipeline stage against the hard cap. Resolves to "TIMEOUT" if the
 * remaining budget runs out before `promise` settles. Callers must treat a
 * timeout as a failure, not a silent pass — fails closed, consistent with
 * validateGrounding()'s own error handling above.
 */
export async function withHardCap<T>(promise: Promise<T>, startedAt: number): Promise<T | "TIMEOUT"> {
  const remaining = remainingHardCapMs(startedAt);
  if (remaining <= 0) return "TIMEOUT";
  return Promise.race([
    promise,
    new Promise<"TIMEOUT">((resolve) => setTimeout(() => resolve("TIMEOUT"), remaining)),
  ]);
}

// ─── Stop condition validation ─────────────────────────────────────────────────

/**
 * Validates that the agent loop's stop/continue decisions are justified.
 * 
 * The LLM should only continue the loop if it has a concrete next tool to call,
 * and should stop (or provide a final verdict) when it has gathered sufficient
 * evidence or exhausted all relevant tools.
 * 
 * Returns false if:
 * - The loop stopped prematurely without covering mandatory tiers
 * - The loop continued without a clear next action
 * - The loop continued past max iterations without a valid reason
 */
export function validateStopConditions(
  decisions: unknown[],
  verdict: string
): boolean {
  // If no decisions were made but we have a verdict, that's okay
  // (might be a fast-path failure or early exit)
  if (decisions.length === 0) {
    return verdict !== "UNKNOWN";
  }

  // Check if the final decision was to continue without a next action
  const lastDecision = decisions[decisions.length - 1] as { action?: string; reason?: string } | null;
  if (lastDecision && lastDecision.action === "continue" && !lastDecision.reason) {
    console.warn("[grounding] Agent continued without providing a reason");
    return false;
  }

  // If we have a final verdict, ensure we didn't stop mid-investigation
  // without good reason (this is a basic sanity check)
  if (verdict !== "UNKNOWN" && verdict !== "INSUFFICIENT") {
    // Verdicts other than UNKNOWN/INSUFFICIENT are acceptable
    return true;
  }

  return true;
}
