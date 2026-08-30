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
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash-lite";
export const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

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
  userMessage: string
): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const response = await fetch(GEMINI_ENDPOINT, {
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

  if (data.error) {
    throw new Error(`Gemini API error ${data.error.code}: ${data.error.message}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  if (!rawText) {
    throw new Error("Gemini returned an empty response");
  }
  return rawText;
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
  tools: readonly unknown[]
): Promise<AgenticResponse> {
  // Gemini's functionDeclarations schema only allows name, description, and
  // parameters — any extra fields (e.g. our internal `tier` metadata) cause
  // a 400 "Unknown name" error. Strip them before sending.
  const functionDeclarations = tools.map((t) => {
    const { tier: _tier, ...rest } = t as Record<string, unknown>;
    return rest;
  });

  const response = await fetch(GEMINI_ENDPOINT, {
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
    throw new Error(`Failed to parse final JSON: ${cleaned.slice(0, 200)}`);
  }
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
