/**
 * llm-score.ts — Gemini-powered rug risk scorer (single-shot path) +
 * chat-answer generator.
 *
 * MOVED from agents/llm-score.ts as part of the agents/ restructuring. The
 * agentic function-calling loop that used to live here (scoreWithLLMAgentic,
 * _reportDecision, buildInitialMessages, appendFunctionResults, the local
 * ToolCall/Message types) has been replaced by agents/orchestrator.ts +
 * agents/specialists/*.ts, which share the transport layer in
 * gemini-client.ts instead of duplicating it.
 *
 * Scoring is now ALWAYS agentic: rugcheck.ts calls runOrchestrator() for
 * every token, ambiguous or not. This file's two remaining jobs are:
 *   - scoreWithLLM: the fallback used ONLY when the orchestrator fails
 *     outright (missing key, network error, hard-cap timeout, etc.) — a
 *     working single-shot score beats no score at all.
 *   - answerAboutToken: the conversational "answer" field shown in chat
 *     mode. This is deliberately a separate, later call rather than part
 *     of scoring — it runs *after* rugcheck.ts has already finalized the
 *     authoritative score/verdict/flags (via computeScore()), so the
 *     answer can never describe a different number than the one actually
 *     displayed. (That was a real inconsistency in the old flow: the
 *     single-shot call used to produce its own score + answer together,
 *     and rugcheck.ts would then silently override the score afterward —
 *     leaving the answer text describing a stale score.)
 *
 * Design principles:
 * - Never returns a default/fallback score. If the LLM call fails for any
 *   reason (missing key, network error, bad JSON, missing fields), the result
 *   is { ok: false, reason }. The caller marks the analysis as UNKNOWN/failed
 *   rather than faking a clean-looking score.
 * - Strict field validation: every required field is type-checked before
 *   the result is accepted. Malformed responses are rejected outright.
 * - rpcWarnings from evidence are injected into the prompt so the LLM
 *   explicitly knows which fields could not be verified.
 * - IMPORTANT: score, verdict, flags, and summary returned here are advisory.
 *   LLMs round to clean integers and can narrate evidence they didn't actually
 *   read. runRugCheckLLM replaces all four with computeScore() / breakdown
 *   helpers so the displayed report is internally consistent. The exception is
 *   verdict === "INSUFFICIENT", which must be preserved.
 */

import type { TokenEvidence } from "./evidence.js";
import type { RiskFlag, RiskLevel } from "./rugcheck-types.js";
import type { ToolCallRecord } from "./rugcheck-types.js";
import type { Venue } from "./utils/constants.js";
import { GEMINI_API_KEY, callGeminiText, stripJsonFences } from "./gemini-client.js";

export type ScoreMode = "alert" | "chat" | "agentic";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LLMScoreSuccess {
  ok: true;
  score: number;
  verdict: RiskLevel | "INSUFFICIENT";
  flags: RiskFlag[];
  summary: string;
  rawModelText: string;
  /** Only present when opts.userQuestion was supplied */
  answer?: string;
  /** Only present in agentic mode: transcript of tool calls made */
  toolCallTranscript?: ToolCallRecord[];
  /** Final decision trace — mirrors toolCallTranscript but isolates the
   *  reasoning for auditability/rendering separately from raw tool I/O. */
  decisionTrace?: import("./utils/interface.js").IterationDecision[];
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

The evidence may include a "venue" field indicating whether the token is on Uniswap V3 or V4:
- V3: Traditional per-pool contracts
- V4: Singleton PoolManager architecture with custom hooks support

For V4 pools, pay special attention to:
- Custom hooks: A malicious hook can act like a hidden tax or blacklist mechanism at the pool level
- Hook address: If non-zero, evaluate it as an additional risk surface

IMPORTANT RULES:
1. Return ONLY valid JSON — no markdown, no prose, no code fences.
2. Treat any field that is null OR appears in rpcWarnings as UNVERIFIED, not as a clean signal. Unverified data should increase, not decrease, your risk score.
3. Do not hallucinate token names, addresses, or numbers not present in the evidence.
4. Score 0–100 where 0 = very safe, 100 = certain rug.
5. Verdict must be exactly one of: "LOW", "MEDIUM", "HIGH", "CRITICAL", "INSUFFICIENT".
   - LOW:      0–24
   - MEDIUM:  25–49
   - HIGH:    50–74
   - CRITICAL: 75–100
   - INSUFFICIENT: When mandatory-tier evidence is unresolved when iteration budget is exhausted
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
9. CHECK "hasLiquidity" FIRST, BEFORE SCORING ANY LIQUIDITY-DEPENDENT FIELD. This is the single most important rule for freshly-launched tokens:
   - hasLiquidity=false means a real on-chain read CONFIRMED the pool has zero liquidity right now — not that a call failed. This is completely normal for a token that is minutes (or seconds) old and the deployer hasn't added LP yet, or the add tx just hasn't mined.
   - When hasLiquidity=false, DO NOT flag or add points for: poolLiquidity/initialLiquidityEth being 0 or null, sellTestPassed being null, lpPositionStatus being "unverified", liquidityEverPulled/burnEventCount, liquidityDeltaPct, or totalSwaps/uniqueTraders/wash-trading fields being 0 or null. None of these can produce a real answer with no pool yet — treat them as "pending, will be re-checked automatically once liquidity lands," not as risk or as unverifiable evidence. Do not include a flag for them at all.
   - When hasLiquidity=false, do NOT penalize "ownership not renounced" at the normal +25 weight — renouncing before liquidity even exists is unusual, not standard practice. If you flag it at all, treat it as low-severity/informational (a few points at most), and instead focus on what privileges the owner role actually has per the source audit (suspiciousFunctions, secondaryAdminDetected).
   - When hasLiquidity=false, source verification (sourceVerified, suspiciousFunctions, secondaryAdminDetected), proxy status (isProxy), deployer wallet reputation (deployerSeenBefore, deployerPriorTokens), and supply distribution (deployerPct, top5HoldersPct) become your PRIMARY signals — score and weight them at full strength, since there is no trading history yet to fall back on. An unverified contract on a brand-new token is a stronger signal than on a token that's been trading for a while (see scoring guide below).
   - The following fields are ALWAYS liquidity-independent and must NEVER be skipped or down-weighted because hasLiquidity=false: deploysLast15Min, deploysLastHour, deploysLast24h (deployer velocity), walletAgeAtDeploySeconds, fundingGapSeconds (wallet age/funding pattern), and preSeededWallets, preSeededPct (pre-liquidity token distribution). Score these at full strength regardless of hasLiquidity.
   - When hasLiquidity=true, score all liquidity-dependent fields normally per the guide below.

SCORING GUIDE:
- Ownership not renounced, hasLiquidity=true (confirmed active owner):  +25 pts, HIGH
- Ownership not renounced, hasLiquidity=false (pre-launch, expected):   +0–5 pts, LOW at most — do not treat as a real risk signal on its own
- Ownership unverifiable (owner() reverted):                +10 pts, MEDIUM
- Upgradeable proxy detected:                               +35 pts, CRITICAL — detail MUST explicitly state the implementation-swap risk, regardless of hasLiquidity
- Proxy detected AND proxyImplementationAudited=false (only the proxy shim's source was checked, not the real logic contract): +15 pts, MEDIUM — detail must say the actual implementation could not be independently verified
- Proxy status unverifiable:                                +10 pts, MEDIUM
- Dev wallet >50% supply:                                   +40 pts, CRITICAL
- Dev wallet 20–50% supply:                                 +20 pts, HIGH
- Top-5 holders >60% supply (excl. pool):                   +20 pts, HIGH
- Holder data unverifiable:                                 +10 pts, MEDIUM
- Deployer seen before (repeat deployer):                    +10 pts, MEDIUM (pattern risk)
- Deployer has 3+ prior tokens:                             +20 pts, HIGH (serial deployer)
- Deployer velocity — 5+ contracts created in last hour:    +35 pts, CRITICAL ("factory pattern" — applies regardless of hasLiquidity)
- Deployer velocity — 3+ contracts created in last 24 h:    +20 pts, HIGH (serial deployer confirmed on-chain — applies regardless of hasLiquidity)
- Deployer wallet age <10 min at deploy time:               +25 pts, HIGH (disposable wallet pattern — applies regardless of hasLiquidity)
- Deployer wallet funded <2 min before deploy:              +15 pts, MEDIUM (purpose-built funding pattern — applies regardless of hasLiquidity)
- Pre-seeded wallets (tokens distributed before liquidity): +10 pts per wallet, capped at 40 pts total, MEDIUM — include preSeededPct in detail when available (applies regardless of hasLiquidity)
- hasLiquidity=false: DO NOT flag zero/null liquidity, LP lock status, sell test, liquidity-pulled history, liquidity delta, or trade-activity fields at all — see rule 9 above.
- Zero in-range liquidity, hasLiquidity=true but eth reading came back 0 or unverifiable post-launch: +40 pts, CRITICAL
- Liquidity unverifiable (hasLiquidity=true but eth read failed):          +15 pts, MEDIUM
- Very low liquidity (<0.5 ETH equivalent), hasLiquidity=true:             +15 pts, MEDIUM
- LP position burned (liquidity removed), hasLiquidity=true:               +40 pts, CRITICAL
- LP position held by EOA (not locked), hasLiquidity=true:                 +25 pts, HIGH
- LP status unverifiable, hasLiquidity=true:                               +10 pts, MEDIUM
- Liquidity ever pulled (burn events detected), hasLiquidity=true:         +30 pts, HIGH
- Liquidity dropped >30% since last snapshot, hasLiquidity=true:           +30 pts, HIGH
- Liquidity dropped >70% since last snapshot, hasLiquidity=true:           +50 pts, CRITICAL
- Sell test failed (confirmed honeypot), hasLiquidity=true:                +50 pts, CRITICAL
- Sell test unverifiable (no suitable holder), hasLiquidity=true:          +5 pts, LOW (inconclusive)
- Source not verified (no source code), hasLiquidity=true:                 +15 pts, MEDIUM
- Source not verified (no source code), hasLiquidity=false (new token — no trading-history fallback either): +30 pts, HIGH
- Suspicious functions found: For each entry in suspiciousFunctions, read the provided snippet and write a detail sentence explaining WHAT the function lets the caller do and HOW it could be abused. +15 pts, MEDIUM per function type — applies regardless of hasLiquidity, and is one of your primary signals when hasLiquidity=false
- Secondary admin detected (ownership renounced but privileged role found): +30 pts, HIGH — "ownership shows renounced but a second privileged role was found in source, renounce may be a decoy" — applies regardless of hasLiquidity
- Source verification failed (API error):                   +5 pts, LOW (inconclusive)
- Total supply = 0 (broken contract):                       +20 pts, HIGH
- Multiple unverified fields together (3+): +10 pts, MEDIUM (compound uncertainty) — when hasLiquidity=false, do NOT count the liquidity-dependent pending fields toward this total; only count genuine RPC/API failures
- Round-trip traders >40% of unique traders, hasLiquidity=true:            +25 pts, HIGH (wash-trading pattern)
- Single trader >50% of total swap volume, hasLiquidity=true:              +30 pts, HIGH (fake volume / one wallet churning)
- Fewer than 5 unique traders with >20 total swaps, hasLiquidity=true:    +20 pts, HIGH (thin organic interest, likely bot activity)
- Buy/sell ratio wildly skewed toward sells early, hasLiquidity=true:      +15 pts, MEDIUM (possible dump in progress)
- Trade scan data unverified (tradeScanPartial=true), hasLiquidity=true:   +10 pts, MEDIUM (incomplete wash-trading analysis)
- V4 custom hook detected (non-zero hook address):          +20 pts, HIGH — custom hooks can implement hidden taxes or blacklists at the pool level, regardless of hasLiquidity
- V4 hook source not verified:                              +15 pts, MEDIUM (cannot verify hook safety)

SANITY CHECKS — apply these before scoring:
- If initialLiquidityEth is > 1,000,000 (one million ETH), it is a math artifact, NOT real liquidity. Treat it the same as null — do NOT use it as evidence of healthy liquidity. Add a flag for it.
- If totalSupply is an astronomically large number inconsistent with a normal token launch (e.g. trillions with 18 decimals), flag it.
- If any numeric field appears in rpcWarnings, that field could not be fetched and must be treated as unverified risk regardless of its value.
- Never reward implausibly large numbers. If a value seems physically impossible, it almost certainly indicates a computation error or a non-standard token — both are risk signals.
- Always read "hasLiquidity" before writing any flag that touches poolLiquidity, initialLiquidityEth, liquidityLocked, sellTestPassed, lpPositionStatus, liquidityEverPulled, burnEventCount, liquidityDeltaPct, or any trade-activity field (totalSwaps, uniqueTraders, buySellRatio, roundTripTraderPct, topTraderSwapSharePct, tradeScanPartial). See rule 9.

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

const VALID_LEVELS = new Set<string>(["LOW", "MEDIUM", "HIGH", "CRITICAL", "INSUFFICIENT"]);

function validateParsed(parsed: unknown): LLMScoreSuccess | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;

  // score
  if (typeof p.score !== "number" || !Number.isInteger(p.score) || p.score < 0 || p.score > 100) return null;

  // verdict
  if (typeof p.verdict !== "string" || !VALID_LEVELS.has(p.verdict)) {
    // Allow INSUFFICIENT which is dynamically added
    if (p.verdict !== "INSUFFICIENT") return null;
  }

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
    verdict: p.verdict as RiskLevel | "INSUFFICIENT",
    flags,
    summary: (p.summary as string).trim(),
    answer:  typeof p.answer === "string" ? p.answer.trim() : undefined,
    rawModelText: "",  // filled in by caller
  };
}

// ─── Main scorer ─────────────────────────────────────────────────────────────

export async function scoreWithLLM(
  evidence: TokenEvidence,
  opts?: { userQuestion?: string; mode?: ScoreMode; venue?: Venue }
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
    rawModelText = await callGeminiText(
      SYSTEM_PROMPT,
      "Understood. I will analyse on-chain evidence and return only valid JSON in the specified format, treating null and unverified fields as risk signals.",
      userMessage
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  }

  // ── Parse JSON ─────────────────────────────────────────────────────────────
  // The model is instructed to return JSON only. Strip any accidental markdown
  // code fences before parsing.
  const cleaned = stripJsonFences(rawModelText);

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

  // Normalize INSUFFICIENT verdict to use -1 score sentinel, matching orchestrator behavior
  if (validated.verdict === "INSUFFICIENT") {
    return { ...validated, score: -1, rawModelText };
  }

  return { ...validated, rawModelText };
}

// ─── Chat-answer generator ──────────────────────────────────────────────────

/**
 * Generates the conversational "answer" field shown in chat mode.
 *
 * Deliberately takes the FINAL, already-computed score/verdict/flags/summary
 * as ground truth rather than deriving its own — this call's only job is to
 * explain that assessment in plain language (optionally answering a specific
 * question), never to re-score. This guarantees the answer text can't
 * contradict the number actually shown in the report.
 *
 * Returns undefined on any failure (missing API key, network error, empty
 * response). A missing answer is never fatal — the caller already has a
 * complete, correctly-scored result without it; chat mode just shows the
 * score/flags/summary on their own in that case.
 */
export async function answerAboutToken(
  evidence: TokenEvidence,
  finalResult: { score: number; verdict: string; flags: RiskFlag[]; summary: string },
  userQuestion?: string
): Promise<string | undefined> {
  if (!GEMINI_API_KEY) return undefined;

  const evidenceJson = JSON.stringify(evidence, null, 2);
  const flagsJson = JSON.stringify(finalResult.flags, null, 2);

  const systemPrompt =
    `You are an expert DeFi security analyst. You have already been given the ` +
    `FINAL, authoritative risk assessment for a token — your only job is to ` +
    `explain it to the user in plain conversational text. Do NOT invent a ` +
    `different score, verdict, or new risk flags; only interpret what you are given.`;

  const questionClause = userQuestion
    ? `The user asked: "${userQuestion}"\n` +
      `Answer that question directly in 2–4 sentences, using only the evidence ` +
      `and assessment below. Do not just restate the summary.`
    : `No specific question was asked — just give a natural, conversational risk ` +
      `read of this token in 2–4 sentences, not a formal restatement of the summary.`;

  const userMessage =
    `FINAL ASSESSMENT (authoritative — do not change these numbers):\n` +
    `Score: ${finalResult.score}/100\n` +
    `Verdict: ${finalResult.verdict}\n` +
    `Summary: ${finalResult.summary}\n` +
    `Flags: ${flagsJson}\n\n` +
    `EVIDENCE:\n${evidenceJson}\n\n` +
    `${questionClause}\n\n` +
    `Respond with plain text only — no JSON, no markdown formatting, no code fences.`;

  try {
    const rawText = await callGeminiText(
      systemPrompt,
      "Understood. I will explain the given assessment in plain conversational text without changing any numbers.",
      userMessage
    );
    const cleaned = stripJsonFences(rawText);
    return cleaned.length > 0 ? cleaned : undefined;
  } catch (err) {
    console.warn(`[llm-score] answerAboutToken failed: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}
