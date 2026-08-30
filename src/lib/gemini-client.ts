/**
 * gemini-client.ts — shared "talk to Gemini" transport layer.
 *
 * This module knows nothing about scoring, flags, verdicts, or rug-pull
 * risk. It only knows how to:
 *   - send a plain system+user prompt and get back trimmed text
 *     (callGeminiText — used by single-shot callers like llm-score.ts and
 *     source-audit.ts)
 *   - send a conversation + tool schema and get back either a parsed final
 *     JSON blob or a list of function calls to run (callGeminiWithTools —
 *     used by the agents/ specialist pipeline)
 *
 * Every module that talks to Gemini's HTTP API should go through here so
 * there is exactly one place that owns the endpoint, the request shape,
 * and the markdown-fence-stripping logic.
 */

// ─── Env ─────────────────────────────────────────────────────────────────────

export const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";

/** Legacy single-model override. Only used as the pool for callers that
 *  don't pass an AgentKey (i.e. nothing in MODEL_POOLS applies to them). */
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";

function endpointFor(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
}

/** Kept for anything that still imports the old constant directly. */
export const GEMINI_ENDPOINT = endpointFor(GEMINI_MODEL);

// ─── Per-agent model pools ─────────────────────────────────────────────────
//
// Each caller (identified by an AgentKey — currently the specialist agent's
// own `name`, or a bespoke key for single-shot callers like source-audit.ts)
// gets an ordered list of models to try. On a 429 (rate limit / quota
// exhausted) we fall through to the next model in the pool, then to
// GLOBAL_FALLBACK_POOL, before finally giving up. Every other error
// (network failure, 4xx/5xx that isn't a rate limit, bad JSON, etc.)
// propagates immediately — 429 is the only condition we retry across models
// for, since anything else retrying wouldn't fix.
//
// Deliberately kept 2-3 deep: extra fallbacks add a round-trip of latency
// per 429 without adding much real headroom once a low-RPD model is already
// paired with a high-RPD one.
export type AgentKey =
  | "source-owner-agent"
  | "source-audit"
  | "deployer-reputation-agent"
  | "holder-distribution-agent"
  | "lp-honeypot-agent"
  | "trading-activity-agent";

export const MODEL_POOLS: Record<AgentKey, readonly string[]> = {
  "source-owner-agent": ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.7-flash"],
  "source-audit": ["gemini-3-flash-preview", "gemini-2.5-flash"],
  "deployer-reputation-agent": ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"],
  "holder-distribution-agent": ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
  "lp-honeypot-agent": ["gemini-3.5-flash-lite", "gemma-4-26b-a4b-it"],
  "trading-activity-agent": ["gemma-4-31b-it", "gemini-3.5-flash-lite"],
};

/** Tried after an AgentKey's own pool is exhausted, and used as the whole
 *  pool for any caller that doesn't pass an AgentKey at all. */
export const GLOBAL_FALLBACK_POOL: readonly string[] = ["gemma-4-26b-a4b-it", "gemma-4-31b-it"];

/** Full ordered list of models to try for a given caller: its own pool (if
 *  it has an AgentKey), then the global fallback pool. Callers with no
 * AgentKey fall back to GEMINI_MODEL + the global fallback pool so they
 * still degrade gracefully on a 429 instead of failing outright. */
function resolvePool(agentKey?: AgentKey): readonly string[] {
  const own = agentKey ? MODEL_POOLS[agentKey] : [GEMINI_MODEL];
  // De-dupe in case a model appears in both the agent's own pool and the
  // global fallback (keeps us from calling the same model twice in a row).
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const m of [...own, ...GLOBAL_FALLBACK_POOL]) {
    if (!seen.has(m)) {
      seen.add(m);
      merged.push(m);
    }
  }
  return merged;
}

/** True for a Gemini rate-limit / quota-exhausted response — the only
 *  condition worth falling through to the next model in the pool for. */
function isRateLimitError(response: Response, data: { error?: { code: number } }): boolean {
  return response.status === 429 || data.error?.code === 429;
}

// ─── Function-calling types ────────────────────────────────────────────────

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCallResponse {
  type: "tool_calls";
  toolCalls: ToolCall[];
  raw: string;
  /** The model's own turn, echoed back verbatim on the next request. */
  modelContent: Message;
}

export interface FinalResponse {
  type: "final";
  json: unknown;
  raw: string;
}

export type AgenticResponse = ToolCallResponse | FinalResponse;

export interface MessagePart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
  [key: string]: unknown; // Make it indexable
}

export interface Message {
  role: string;
  parts: MessagePart[];
}

// ─── Plain text call (no tools) ────────────────────────────────────────────

/**
 * Prime the model with a system prompt (as a fake first user/model
 * exchange, matching Gemini's lack of a native system role in this API
 * version) and send a single user message. Returns the raw trimmed text,
 * with markdown code fences stripped.
 *
 * Throws on network failure, a non-2xx response, a Gemini-reported error,
 * or an empty response — callers decide how to turn that into their own
 * failure shape.
 */
export async function callGeminiText(
  systemPrompt: string,
  primerAck: string,
  userMessage: string,
  agentKey?: AgentKey
): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const pool = resolvePool(agentKey);
  let lastRateLimitErr: Error | null = null;

  for (const model of pool) {
    const response = await fetch(endpointFor(model), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: systemPrompt }] },
          { role: "model", parts: [{ text: primerAck }] },
          { role: "user", parts: [{ text: userMessage }] },
        ],
      }),
    });

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { code: number; message: string };
    };

    if (isRateLimitError(response, data)) {
      lastRateLimitErr = new Error(
        `Gemini API error 429: ${data.error?.message ?? "rate limited"} (model: ${model})` 
      );
      continue; // try the next model in the pool
    }
    if (data.error) {
      throw new Error(`Gemini API error ${data.error.code}: ${data.error.message} (model: ${model})`);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText} (model: ${model})`);
    }

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    if (!rawText) {
      throw new Error(`Gemini returned an empty response (model: ${model})`);
    }
    return rawText;
  }

  // Every model in the pool was rate-limited.
  throw lastRateLimitErr ?? new Error("Gemini API error: all models in pool were rate limited");
}

/** Strip accidental markdown code fences before JSON.parse. */
export function stripJsonFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

// ─── Function-calling call ──────────────────────────────────────────────────

/**
 * Call Gemini with function calling support.
 * Returns either tool calls to execute (plus the exact model content that
 * requested them, so it can be echoed back verbatim) or a final JSON response.
 */
export async function callGeminiWithTools(
  messages: Array<{ role: string; parts: Array<Record<string, unknown>> }>,
  tools: readonly unknown[],
  agentKey?: AgentKey
): Promise<AgenticResponse> {
  // Gemini's functionDeclarations schema only allows name, description, and
  // parameters — any extra fields (e.g. our internal `tier` metadata) cause
  // a 400 "Unknown name" error. Strip them before sending.
  const functionDeclarations = tools.map((t) => {
    const { tier: _tier, ...rest } = t as Record<string, unknown>;
    return rest;
  });

  const pool = resolvePool(agentKey);
  let lastRateLimitErr: Error | null = null;

  for (const model of pool) {
    const response = await fetch(endpointFor(model), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: messages,
        tools: [{ functionDeclarations }],
      }),
    });

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { role?: string; parts?: MessagePart[] } }>;
      error?: { code: number; message: string };
    };

    if (isRateLimitError(response, data)) {
      lastRateLimitErr = new Error(
        `Gemini API error 429: ${data.error?.message ?? "rate limited"} (model: ${model})` 
      );
      continue; // try the next model in the pool
    }
    if (data.error) {
      throw new Error(`Gemini API error ${data.error.code}: ${data.error.message} (model: ${model})`);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText} (model: ${model})`);
    }

    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts) {
      throw new Error(`Gemini returned empty response (model: ${model})`);
    }

    const parts = candidate.content.parts;
    const rawText = parts.map((p) => p.text ?? "").join("");

    // Check for function calls. Gemini's own turn — role "model" — must be
    // echoed back verbatim (all parts, including any function calls) so the
    // subsequent functionResponse turn lines up with it.
    const functionCalls = parts
      .filter(
        (p): p is MessagePart & { functionCall: { name: string; args: Record<string, unknown> } } =>
          !!p.functionCall
      )
      .map((p) => ({ name: p.functionCall.name, args: p.functionCall.args }));

    if (functionCalls.length > 0) {
      return {
        type: "tool_calls",
        toolCalls: functionCalls,
        raw: rawText,
        modelContent: { role: "model", parts },
      };
    }

    // Parse as final JSON response
    const cleaned = stripJsonFences(rawText);

    try {
      const json = JSON.parse(cleaned);
      return { type: "final", json, raw: rawText };
    } catch {
      throw new Error(`Failed to parse final JSON: ${cleaned.slice(0, 200)} (model: ${model})`);
    }
  }

  // Every model in the pool was rate-limited.
  throw lastRateLimitErr ?? new Error("Gemini API error: all models in pool were rate limited");
}

/**
 * Append a completed round of tool calls to the message history.
 *
 * Gemini requires:
 *   1. The model's own turn that requested the call(s) — role "model" —
 *      echoed back exactly as returned (not reconstructed as role "user").
 *   2. A single immediately-following "user" turn carrying ALL of that
 *      turn's functionResponse parts together. When a model turn issues
 *      several function calls at once, splitting them into separate
 *      call/response turn pairs violates Gemini's strict turn ordering
 *      ("a functionResponse part must appear in a user turn that comes
 *      immediately after the model turn containing the matching
 *      functionCall") and the API rejects the request with a 400.
 */
export function appendFunctionResults(
  messages: Message[],
  modelContent: Message,
  results: Array<{ call: ToolCall; output: unknown }>
): Message[] {
  return [
    ...messages,
    modelContent,
    {
      role: "user",
      parts: results.map(({ call, output }) => ({
        functionResponse: { name: call.name, response: output },
      })),
    },
  ];
}
