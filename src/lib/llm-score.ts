/**
 * llm-score.ts — Gemini-powered rug risk scorer.
 *
 * Takes a TokenEvidence object (all raw on-chain facts, no pre-computed flags),
 * sends it to Gemini with a structured prompt, and returns a validated score.
 *
 * Design principles:
 * - Never returns a default/fallback score. If the LLM call fails for any
 *   reason (missing key, network error, bad JSON, missing fields), the result
 *   is { ok: false, reason }. The caller decides what to do with a failure —
 *   typically force score=100/CRITICAL so failures never look clean.
 * - Strict field validation: every required field is type-checked before
 *   the result is accepted. Malformed responses are rejected outright.
 * - rpcWarnings from evidence are injected into the prompt so the LLM
 *   explicitly knows which fields could not be verified.
 */

import type { TokenEvidence } from "./evidence.js";
import type { RiskFlag, RiskLevel } from "./rugcheck-types.js";
import type { ToolCallRecord } from "./rugcheck-types.js";

export type ScoreMode = "alert" | "chat" | "agentic";

// ─── Env ─────────────────────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL   = process.env.GEMINI_MODEL   ?? "gemini-2.0-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LLMScoreSuccess {
  ok: true;
  score: number;
  verdict: RiskLevel;
  flags: RiskFlag[];
  summary: string;
  rawModelText: string;
  /** Only present when opts.userQuestion was supplied */
  answer?: string;
  /** Only present in agentic mode: transcript of tool calls made */
  toolCallTranscript?: ToolCallRecord[];
}

export interface LLMScoreFailure {
  ok: false;
  reason: string;
  rawModelText?: string;
}

export type LLMScoreResult = LLMScoreSuccess | LLMScoreFailure;

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert DeFi security analyst specialising in rug-pull detection on Base (an OP-Stack EVM chain).

You will be given a JSON object containing raw on-chain evidence about a newly launched ERC-20 token. Your job is to score the rug-pull risk.

IMPORTANT RULES:
1. Return ONLY valid JSON — no markdown, no prose, no code fences.
2. Treat any field that is null OR appears in rpcWarnings as UNVERIFIED, not as a clean signal. Unverified data should increase, not decrease, your risk score.
3. Do not hallucinate token names, addresses, or numbers not present in the evidence.
4. Score 0–100 where 0 = very safe, 100 = certain rug.
5. Verdict must be exactly one of: "LOW", "MEDIUM", "HIGH", "CRITICAL".
   - LOW:      0–24
   - MEDIUM:  25–49
   - HIGH:    50–74
   - CRITICAL: 75–100
6. Each flag must have: id (snake_case string), label (short string), detail (evidence-backed sentence), severity (LOW/MEDIUM/HIGH/CRITICAL), points (integer 0–40).
7. summary must be a single sentence citing the top 1–2 risk factors.
8. You will be told the OUTPUT MODE for this request:
   - "alert": 'summary' must be ONE short, punchy sentence (max ~18 words) fit for a push
     notification. Include only the 1–3 MOST material flags in 'flags' — omit minor or
     redundant ones even if the evidence supports more. Do not include an "answer" field.
   - "chat" with a specific question: add an "answer" field (string). It must directly and
     conversationally answer THAT question in 2–4 sentences, using only evidence relevant to
     it. Do not just restate 'summary'.
   - "chat" with no question (bare address): add an "answer" field with a natural,
     conversational risk read of the token (2–4 sentences) — as if explaining it to someone,
     not a formal restatement of 'summary'.
   - "agentic": You have access to tools to gather additional evidence. Use them when the initial evidence is ambiguous or incomplete. Before finalizing, consider what a scammer would have done to pass the checks you've run, and issue one more tool call if it surfaces a gap.

SCORING GUIDE:
- Ownership not renounced (confirmed active owner address):  +25 pts, HIGH
- Ownership unverifiable (owner() reverted):                +10 pts, MEDIUM
- Upgradeable proxy detected:                               +35 pts, CRITICAL — detail MUST explicitly state the implementation-swap risk
- Proxy status unverifiable:                                +10 pts, MEDIUM
- Dev wallet >50% supply:                                   +40 pts, CRITICAL
- Dev wallet 20–50% supply:                                 +20 pts, HIGH
- Top-5 holders >60% supply (excl. pool):                   +20 pts, HIGH
- Holder data unverifiable:                                 +10 pts, MEDIUM
- Deployer seen before (repeat deployer):                    +10 pts, MEDIUM (pattern risk)
- Deployer has 3+ prior tokens:                             +20 pts, HIGH (serial deployer)
- Zero in-range liquidity (confirmed):                      +40 pts, CRITICAL
- Liquidity unverifiable:                                   +15 pts, MEDIUM
- Very low liquidity (<0.5 ETH equivalent):                 +15 pts, MEDIUM
- LP position burned (liquidity removed):                    +40 pts, CRITICAL
- LP position held by EOA (not locked):                      +25 pts, HIGH
- LP status unverifiable:                                    +10 pts, MEDIUM
- Liquidity ever pulled (burn events detected):              +30 pts, HIGH
- Liquidity dropped >30% since last snapshot:               +30 pts, HIGH
- Liquidity dropped >70% since last snapshot:               +50 pts, CRITICAL
- Sell test failed (confirmed honeypot):                     +50 pts, CRITICAL
- Sell test unverifiable (no suitable holder):               +5 pts, LOW (inconclusive)
- Source not verified (no source code):                      +15 pts, MEDIUM
- Suspicious functions found: For each entry in suspiciousFunctions, read the provided snippet and write a detail sentence explaining WHAT the function lets the caller do and HOW it could be abused. +15 pts, MEDIUM per function type
- Secondary admin detected (ownership renounced but privileged role found): +30 pts, HIGH — "ownership shows renounced but a second privileged role was found in source, renounce may be a decoy"
- Source verification failed (API error):                   +5 pts, LOW (inconclusive)
- Total supply = 0 (broken contract):                       +20 pts, HIGH
- Multiple unverified fields together (3+):                 +10 pts, MEDIUM (compound uncertainty)
- Round-trip traders >40% of unique traders:                +25 pts, HIGH (wash-trading pattern)
- Single trader >50% of total swap volume:                  +30 pts, HIGH (fake volume / one wallet churning)
- Fewer than 5 unique traders with >20 total swaps:        +20 pts, HIGH (thin organic interest, likely bot activity)
- Buy/sell ratio wildly skewed toward sells early:          +15 pts, MEDIUM (possible dump in progress)
- Trade scan data unverified (tradeScanPartial=true):       +10 pts, MEDIUM (incomplete wash-trading analysis)

SANITY CHECKS — apply these before scoring:
- If initialLiquidityEth is > 1,000,000 (one million ETH), it is a math artifact, NOT real liquidity. Treat it the same as null — do NOT use it as evidence of healthy liquidity. Add a flag for it.
- If totalSupply is an astronomically large number inconsistent with a normal token launch (e.g. trillions with 18 decimals), flag it.
- If any numeric field appears in rpcWarnings, that field could not be fetched and must be treated as unverified risk regardless of its value.
- Never reward implausibly large numbers. If a value seems physically impossible, it almost certainly indicates a computation error or a non-standard token — both are risk signals.

Required JSON output shape:
{
  "score": <integer 0–100>,
  "verdict": <"LOW"|"MEDIUM"|"HIGH"|"CRITICAL">,
  "flags": [
    {
      "id": <string>,
      "label": <string>,
      "detail": <string>,
      "severity": <"LOW"|"MEDIUM"|"HIGH"|"CRITICAL">,
      "points": <integer>
    }
  ],
  "summary": <string>
}`;

// ─── Validator ────────────────────────────────────────────────────────────────

const VALID_LEVELS = new Set<string>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

function validateParsed(parsed: unknown): LLMScoreSuccess | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;

  // score
  if (typeof p.score !== "number" || !Number.isInteger(p.score) || p.score < 0 || p.score > 100) return null;

  // verdict
  if (typeof p.verdict !== "string" || !VALID_LEVELS.has(p.verdict)) return null;

  // summary
  if (typeof p.summary !== "string" || p.summary.trim().length === 0) return null;

  // flags
  if (!Array.isArray(p.flags)) return null;
  const flags: RiskFlag[] = [];
  for (const f of p.flags) {
    if (typeof f !== "object" || f === null) return null;
    const flag = f as Record<string, unknown>;
    if (
      typeof flag.id       !== "string" ||
      typeof flag.label    !== "string" ||
      typeof flag.detail   !== "string" ||
      typeof flag.severity !== "string" || !VALID_LEVELS.has(flag.severity) ||
      typeof flag.points   !== "number" || !Number.isInteger(flag.points)
    ) return null;

    flags.push({
      id:       flag.id       as string,
      label:    flag.label    as string,
      detail:   flag.detail   as string,
      severity: flag.severity as RiskLevel,
      points:   flag.points   as number,
    });
  }

  return {
    ok:      true,
    score:   p.score   as number,
    verdict: p.verdict as RiskLevel,
    flags,
    summary: (p.summary as string).trim(),
    answer:  typeof p.answer === "string" ? p.answer.trim() : undefined,
    rawModelText: "",  // filled in by caller
  };
}

// ─── Main scorer ─────────────────────────────────────────────────────────────

export async function scoreWithLLM(
  evidence: TokenEvidence,
  opts?: { userQuestion?: string; mode?: ScoreMode }
): Promise<LLMScoreResult> {
  // ── Guard: no API key ──────────────────────────────────────────────────────
  if (!GEMINI_API_KEY) {
    return { ok: false, reason: "GEMINI_API_KEY is not set" };
  }

  // ── Build prompt ───────────────────────────────────────────────────────────
  // We inject the evidence as a JSON block so the model has every fact laid
  // out explicitly. rpcWarnings is the most important field — it tells the
  // model which numbers are unverified and should be treated with suspicion.
  const evidenceJson = JSON.stringify(evidence, null, 2);

  const mode = opts?.mode ?? "chat";

  const modeClause = mode === "alert"
    ? `\n\nOUTPUT MODE: "alert" — this is going straight into a push notification. Keep ` +
      `'summary' to one short punchy sentence. Include only the 1–3 most material flags. ` +
      `Do NOT include an "answer" field.`
    : opts?.userQuestion
      ? `\n\nOUTPUT MODE: "chat" — the user asked: "${opts.userQuestion}"\n` +
        `Add an "answer" field (string) that directly and conversationally answers THIS ` +
        `question using only the evidence above. Do not just repeat 'summary'.`
      : `\n\nOUTPUT MODE: "chat" — no specific question was asked, just the token address. ` +
        `Add an "answer" field (string) with a natural, conversational risk read of this ` +
        `token (2–4 sentences), not a formal restatement of 'summary'.`;

  const userMessage =
    `Analyse the following on-chain evidence and return a rug-check risk score.\n\n` +
    `PAY SPECIAL ATTENTION to the "rpcWarnings" array — any field mentioned there ` +
    `could not be fetched from the chain and should be treated as unverified risk, ` +
    `not as a clean/safe reading.\n\n` +
    `TOKEN EVIDENCE:\n${evidenceJson}` +
    modeClause;

  // ── Call Gemini ────────────────────────────────────────────────────────────
  let rawModelText = "";
  try {
    const response = await fetch(GEMINI_ENDPOINT, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          // Fake first exchange to prime the model's persona
          { role: "user",  parts: [{ text: SYSTEM_PROMPT }] },
          { role: "model", parts: [{ text: "Understood. I will analyse on-chain evidence and return only valid JSON in the specified format, treating null and unverified fields as risk signals." }] },
          // Actual request
          { role: "user",  parts: [{ text: userMessage }] },
        ],
      }),
    });

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { code: number; message: string };
    };

    if (data.error) {
      return { ok: false, reason: `Gemini API error ${data.error.code}: ${data.error.message}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}: ${response.statusText}` };
    }

    rawModelText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    if (!rawModelText) {
      return { ok: false, reason: "Gemini returned an empty response", rawModelText };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Network error calling Gemini: ${msg}` };
  }

  // ── Parse JSON ─────────────────────────────────────────────────────────────
  // The model is instructed to return JSON only. Strip any accidental markdown
  // code fences before parsing.
  const cleaned = rawModelText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/,       "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      ok: false,
      reason: `Model returned non-JSON response: ${cleaned.slice(0, 200)}`,
      rawModelText,
    };
  }

  // ── Validate ───────────────────────────────────────────────────────────────
  const validated = validateParsed(parsed);
  if (!validated) {
    return {
      ok: false,
      reason: `Model returned JSON with missing/invalid fields: ${cleaned.slice(0, 300)}`,
      rawModelText,
    };
  }

  return { ...validated, rawModelText };
}

// ─── Agentic function-calling variant ───────────────────────────────────────────

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface ToolCallResponse {
  type: "tool_calls";
  toolCalls: ToolCall[];
  raw: string;
}

interface FinalResponse {
  type: "final";
  json: unknown;
  raw: string;
}

type AgenticResponse = ToolCallResponse | FinalResponse;

interface MessagePart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
  [key: string]: unknown; // Make it indexable
}

interface Message {
  role: string;
  parts: MessagePart[];
}

/**
 * Call Gemini with function calling support.
 * Returns either tool calls to execute or a final JSON response.
 */
async function callGeminiWithTools(
  messages: Array<{ role: string; parts: Array<Record<string, unknown>> }>,
  tools: readonly unknown[]
): Promise<AgenticResponse> {
  const response = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: messages,
      tools: [{ functionDeclarations: tools }],
    }),
  });

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }> } }>;
    error?: { code: number; message: string };
  };

  if (data.error) {
    throw new Error(`Gemini API error ${data.error.code}: ${data.error.message}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const candidate = data.candidates?.[0];
  if (!candidate?.content?.parts) {
    throw new Error("Gemini returned empty response");
  }

  const parts = candidate.content.parts as MessagePart[];
  const rawText = parts.map(p => p.text ?? "").join("");
  
  // Check for function calls
  const functionCalls = parts
    .filter(p => p.functionCall)
    .map(p => ({ name: p.functionCall!.name, args: p.functionCall!.args }));

  if (functionCalls.length > 0) {
    return { type: "tool_calls", toolCalls: functionCalls, raw: rawText };
  }

  // Parse as final JSON response
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    const json = JSON.parse(cleaned);
    return { type: "final", json, raw: rawText };
  } catch {
    throw new Error(`Failed to parse final JSON: ${cleaned.slice(0, 200)}`);
  }
}

/**
 * Build initial messages for the agentic loop.
 */
function buildInitialMessages(evidence: TokenEvidence): Message[] {
  const evidenceJson = JSON.stringify(evidence, null, 2);
  
  return [
    {
      role: "user",
      parts: [{
        text: `${SYSTEM_PROMPT}

You are now operating in AGENTIC mode. You have access to tools to gather additional evidence beyond the initial scan.

INITIAL EVIDENCE:
${evidenceJson}

Your task:
1. Review the initial evidence
2. If the evidence is ambiguous or incomplete, use tools to gather more information
3. Before finalizing, ask yourself what a scammer would have done to pass the checks you've run, and issue one more tool call if it surfaces a gap
4. When you have sufficient evidence, return your final risk assessment as JSON

IMPORTANT: Every numeric fact in your final flags must be traceable to a tool result. Do not hallucinate numbers.
`,
      }],
    },
  ];
}

/**
 * Append a function result to the message history.
 */
function appendFunctionResult(
  messages: Message[],
  call: ToolCall,
  result: unknown
): Message[] {
  const newMessages = [...messages];
  
  // Add the function call
  newMessages.push({
    role: "user",
    parts: [{ functionCall: { name: call.name, args: call.args } }],
  });
  
  // Add the function response
  newMessages.push({
    role: "function",
    parts: [{ functionResponse: { name: call.name, response: result } }],
  });
  
  return newMessages;
}

/**
 * Score with LLM in agentic mode with function calling.
 */
export async function scoreWithLLMAgentic(
  evidence: TokenEvidence,
  dispatchTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  tools: readonly unknown[],
  opts?: { maxIterations?: number }
): Promise<LLMScoreResult> {
  if (!GEMINI_API_KEY) {
    return { ok: false, reason: "GEMINI_API_KEY is not set" };
  }

  const maxIterations = opts?.maxIterations ?? 12;
  let messages = buildInitialMessages(evidence);
  const transcript: ToolCallRecord[] = [];

  for (let i = 0; i < maxIterations; i++) {
    try {
      const response = await callGeminiWithTools(messages, tools);

      if (response.type === "final") {
        const validated = validateParsed(response.json);
        if (!validated) {
          return {
            ok: false,
            reason: `Model returned JSON with missing/invalid fields: ${response.raw.slice(0, 300)}`,
            rawModelText: response.raw,
          };
        }

        return {
          ...validated,
          rawModelText: response.raw,
          toolCallTranscript: transcript,
        };
      }

      // Execute tool calls
      for (const call of response.toolCalls) {
        try {
          const output = await dispatchTool(call.name, call.args);
          transcript.push({
            name: call.name,
            args: call.args,
            output,
            ts: Date.now(),
          });
          messages = appendFunctionResult(messages, call, output);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          transcript.push({
            name: call.name,
            args: call.args,
            output: { error: msg },
            ts: Date.now(),
          });
          messages = appendFunctionResult(messages, call, { error: msg });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `Agentic loop failed: ${msg}` };
    }
  }

  return {
    ok: false,
    reason: `Agent exceeded ${maxIterations} tool calls without a verdict`,
  };
}
