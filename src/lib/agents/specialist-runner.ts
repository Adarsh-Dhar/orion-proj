/**
 * agents/specialist-runner.ts — shared bounded Gemini tool-calling loop.
 *
 * Every specialist in specialists/*.ts is "a small, single-purpose Gemini
 * call using gemini-client.ts + one tool from agents/tools.ts" (per the
 * restructuring plan) — the loop mechanics (build messages, dispatch tool
 * calls, append function results, parse the final flags[] JSON) are
 * identical across all five, so they live here once instead of five times.
 */

import type { TokenEvidence } from "../evidence.js";
import type { RiskFlag } from "../rugcheck-types.js";
import type { IterationDecision } from "../utils/interface.js";
import type { ToolContext } from "../utils/interface.js";
import type { SpecialistResult } from "./types.js";
import {
  callGeminiWithTools,
  appendFunctionResults,
  stripJsonFences,
  GEMINI_API_KEY,
  type Message,
  type AgentKey,
} from "../gemini-client.js";

const VALID_SEVERITIES = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

function validateFlags(parsed: unknown): RiskFlag[] | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p.flags)) return null;

  const flags: RiskFlag[] = [];
  for (const f of p.flags) {
    if (typeof f !== "object" || f === null) return null;
    const flag = f as Record<string, unknown>;
    if (
      typeof flag.id !== "string" ||
      typeof flag.label !== "string" ||
      typeof flag.detail !== "string" ||
      typeof flag.severity !== "string" ||
      !VALID_SEVERITIES.has(flag.severity) ||
      typeof flag.points !== "number" ||
      !Number.isInteger(flag.points)
    ) {
      return null;
    }
    flags.push({
      id: flag.id,
      label: flag.label,
      detail: flag.detail,
      severity: flag.severity as RiskFlag["severity"],
      points: flag.points,
    });
  }
  return flags;
}

/** Minimal sentinel decision object — the new pipeline has no per-call
 *  `_reportDecision` step (that was specific to the old single-loop
 *  agent-loop.ts), but ToolCallRecord.decision is a required field, so
 *  every transcript entry needs one. */
function sentinelDecision(reason: string): IterationDecision {
  return {
    runningScore: 0,
    bandProximity: "deep",
    unresolvedMandatory: [],
    reason,
    action: "continue",
  };
}

export interface RunSpecialistOpts {
  name: string;
  evidence: TokenEvidence;
  ctx: ToolContext;
  tools: readonly unknown[];
  domainPrompt: string;
  dispatch: (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
  maxIterations?: number;
}

export async function runSpecialistToolLoop(opts: RunSpecialistOpts): Promise<SpecialistResult> {
  const { name, evidence, ctx, tools, domainPrompt, dispatch } = opts;
  const maxIterations = opts.maxIterations ?? 4;
  const warnings: string[] = [];
  const toolCallTranscript: SpecialistResult["toolCallTranscript"] = [];

  if (!GEMINI_API_KEY) {
    return { agentName: name, flags: [], toolCallTranscript, warnings: ["GEMINI_API_KEY is not set"] };
  }

  const evidenceJson = JSON.stringify(evidence, null, 2);
  let evidenceText = `${domainPrompt}\n\nTOKEN EVIDENCE:\n${evidenceJson}\n\n`;
  
  if (ctx.candidateHolder) {
    evidenceText += `Candidate holder for sell test: ${ctx.candidateHolder}\n\n`;
  }
  
  evidenceText += `Use your tool if the evidence above doesn't already answer your domain's ` +
    `questions. When you're done, return ONLY valid JSON of the shape ` +
    `{ "flags": [ { "id": string, "label": string, "detail": string, ` +
    `"severity": "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", "points": integer } ] } — ` +
    `an empty flags array is a valid, expected answer when nothing in your ` +
    `domain looks risky. No markdown, no prose outside the JSON.`;
  
  let messages: Message[] = [
    {
      role: "user",
      parts: [
        {
          text: evidenceText,
        },
      ],
    },
  ];

  for (let i = 0; i < maxIterations; i++) {
    let response;
    try {
      response = await callGeminiWithTools(
        messages as unknown as Array<{ role: string; parts: Array<Record<string, unknown>> }>,
        tools,
        // Every specialist's `name` is one of the AgentKey pool keys in
        // gemini-client.ts's MODEL_POOLS (source-owner-agent,
        // deployer-reputation-agent, holder-distribution-agent,
        // lp-honeypot-agent, trading-activity-agent) — reusing it here
        // means each specialist automatically gets its assigned pool
        // without a second place to keep the mapping in sync.
        name as AgentKey
      );
    } catch (err) {
      warnings.push(`[${name}] ${err instanceof Error ? err.message : String(err)}`);
      return { agentName: name, flags: [], toolCallTranscript, warnings };
    }

    if (response.type === "final") {
      const flags = validateFlags(response.json);
      if (!flags) {
        warnings.push(`[${name}] model returned invalid flags JSON: ${response.raw.slice(0, 200)}`);
        return { agentName: name, flags: [], toolCallTranscript, warnings };
      }
      return { agentName: name, flags, toolCallTranscript, warnings };
    }

    const results: Array<{ call: { name: string; args: Record<string, unknown> }; output: unknown }> = [];
    for (const call of response.toolCalls) {
      try {
        const output = await dispatch(call.name, call.args, ctx);
        toolCallTranscript.push({
          name: call.name,
          args: call.args,
          output,
          ts: Date.now(),
          decision: sentinelDecision(`[${name}] called ${call.name}`),
        });
        results.push({ call, output });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const output = { error: msg };
        toolCallTranscript.push({
          name: call.name,
          args: call.args,
          output,
          ts: Date.now(),
          decision: sentinelDecision(`[${name}] ${call.name} failed`),
        });
        results.push({ call, output });
      }
    }
    messages = appendFunctionResults(messages, response.modelContent, results);
  }

  warnings.push(`[${name}] exceeded ${maxIterations} tool calls without a final answer`);
  return { agentName: name, flags: [], toolCallTranscript, warnings };
}
