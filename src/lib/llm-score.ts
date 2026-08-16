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

SCORING GUIDE:
- Ownership not renounced (confirmed active owner address):  +25 pts, HIGH
- Ownership unverifiable (owner() reverted):                +10 pts, MEDIUM
- Upgradeable proxy detected:                               +35 pts, CRITICAL
- Proxy status unverifiable:                                +10 pts, MEDIUM
- Dev wallet >50% supply:                                   +40 pts, CRITICAL
- Dev wallet 20–50% supply:                                 +20 pts, HIGH
- Top-5 holders >60% supply (excl. pool):                   +20 pts, HIGH
- Holder data unverifiable:                                 +10 pts, MEDIUM
- Zero in-range liquidity (confirmed):                      +40 pts, CRITICAL
- Liquidity unverifiable:                                   +15 pts, MEDIUM
- Very low liquidity (<0.5 ETH equivalent):                 +15 pts, MEDIUM
- Total supply = 0 (broken contract):                       +20 pts, HIGH
- Multiple unverified fields together (3+):                 +10 pts, MEDIUM (compound uncertainty)

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
  opts?: { userQuestion?: string }
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

  const questionClause = opts?.userQuestion
    ? `\n\nADDITIONAL USER QUESTION:\nAlso answer this specific question from the user, ` +
      `using only the evidence above: "${opts.userQuestion}"\n` +
      `Add an "answer" field (string) to your JSON response with the direct answer.`
    : "";

  const userMessage =
    `Analyse the following on-chain evidence and return a rug-check risk score.\n\n` +
    `PAY SPECIAL ATTENTION to the "rpcWarnings" array — any field mentioned there ` +
    `could not be fetched from the chain and should be treated as unverified risk, ` +
    `not as a clean/safe reading.\n\n` +
    `TOKEN EVIDENCE:\n${evidenceJson}` +
    questionClause;

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
