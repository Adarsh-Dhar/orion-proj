/**
 * source-audit.ts — LLM-powered replacement for the flat
 * SUSPICIOUS_SOURCE_KEYWORDS / PRIVILEGE_KEYWORDS grep in evidence.ts.
 *
 * WHY THIS EXISTS:
 * A plain `source.includes(keyword)` fires on comments, unrelated variable
 * names, and dead code, and is trivially evaded by renaming an identifier.
 * It also can't reason about INTENT — a cooldown that applies equally to
 * every address and a cooldown that quietly exempts the owner look
 * identical to a keyword scan but are not the same risk.
 *
 * This module instead:
 *   1. Splits verified source into individual function/modifier blocks
 *      (same candidate set the old keyword scan effectively worked over).
 *   2. Sends those candidates to Gemini with a RUBRIC prompt that forces
 *      the same step-by-step reasoning a human auditor uses — mechanical
 *      effect, access control, user impact, precedent match — BEFORE it is
 *      allowed to emit a verdict. A handful of contrastive few-shot pairs
 *      (benign vs malicious versions of the same surface pattern) are
 *      included so the model learns to discriminate on substance, not shape.
 *   3. Strictly validates the structured JSON response, per item. A
 *      malformed individual item is dropped (not trusted); if EVERY item
 *      fails validation, or the call/response fails at any earlier stage
 *      (missing API key, network error, non-2xx, unparseable JSON, empty
 *      'functions' array), this throws rather than degrading to a heuristic.
 *
 * Design principles (matching llm-score.ts):
 * - Never silently treat an LLM failure as "no risk found". There is no
 *   keyword-heuristic fallback here on purpose — a caller that can't get a
 *   trustworthy audit should see a visible failure, not a token that quietly
 *   gets reported "clean" off a much weaker grep. Only genuinely non-fatal
 *   conditions (some items dropped, some findings low-confidence) are
 *   recorded as warnings; everything else propagates as a thrown error.
 * - Every finding is confidence-scored; callers should threshold on it
 *   rather than trusting every emitted flag equally.
 * - The prompt asks for reasoning BEFORE the verdict fields, because
 *   forcing the rubric steps to be filled in first measurably constrains
 *   the final judgment instead of letting the model free-associate a flag.
 */

import { createHash } from "node:crypto";
import type { FunctionAudit, SourceAuditMethod } from "./llm-types.js";
import { GEMINI_API_KEY, callGeminiText, stripJsonFences } from "./gemini-client.js";

/** Findings below this confidence are kept out of suspiciousFunctions/secondaryAdminDetected
 *  but still logged as warnings — low-confidence LLM output should not silently
 *  disappear, but it also shouldn't carry full scoring weight. */
const CONFIDENCE_THRESHOLD = 0.5;

/** Hard cap on how many function candidates we send per request — bounds
 *  cost/latency on pathologically large verified-source files. */
const MAX_CANDIDATES = 25;

/** Max lines per candidate body sent to the model (mirrors the old
 *  extractFunctionBody truncation in evidence.ts). */
const MAX_SNIPPET_LINES = 40;

// ─── Cache on identical input ─────────────────────────────────────────────────
//
// Many rug-pull tokens are deployed from the exact same boilerplate/template
// contract (same source, different address/owner). Without a cache, every
// re-deploy of the same template burns a fresh Gemini call for a verdict
// we've already computed. This is an in-memory, per-process cache — it does
// NOT survive a restart. If you need cross-restart persistence, the natural
// place to move this is state.ts (same pattern as deployer history — one
// Redis key per cache entry) or the Upstash-backed analysis-store.ts, keyed
// the same way.
//
// Cache key includes ownershipRenounced + ownerAddress alongside a hash of
// the source, because those two inputs can change the secondaryAdminCandidate
// verdict even for byte-identical source — they are not just cosmetic.
const sourceAuditCache = new Map<string, SourceAuditResult>();

function cacheKey(source: string, ownershipRenounced: boolean | null, ownerAddress: string | null): string {
  const hash = createHash("sha256").update(source).digest("hex");
  return `${hash}|${ownershipRenounced ?? "null"}|${(ownerAddress ?? "").toLowerCase()}`;
}

// ─── Public result type ───────────────────────────────────────────────────────

export interface SourceAuditResult {
  suspiciousFunctions: { name: string; snippet: string }[];
  secondaryAdminDetected: boolean;
  secondaryAdminSnippet: string | null;
  method: SourceAuditMethod;
  /** Full rubric-level detail, including low-confidence/benign findings, for logging. */
  functionAudits: FunctionAudit[];
}

// ─── Step 1: split source into candidate function/modifier blocks ────────────

interface CandidateBlock {
  name: string;
  body: string;
}

function findMatchingBrace(source: string, startIndex: number): number | null {
  let braceCount = 0;
  for (let i = startIndex; i < source.length; i++) {
    if (source[i] === "{") braceCount++;
    else if (source[i] === "}") {
      braceCount--;
      if (braceCount === 0) return i;
    }
  }
  return null;
}

function truncate(body: string): string {
  const lines = body.split("\n");
  if (lines.length <= MAX_SNIPPET_LINES) return body;
  return lines.slice(0, MAX_SNIPPET_LINES).join("\n") + "\n  // ... (truncated)";
}

/**
 * Parse every top-level function/modifier out of verified Solidity source.
 * This intentionally mirrors what the old keyword scan implicitly worked
 * over — every declared function — rather than only ones matching a keyword,
 * because the whole point is to let the model judge blocks a keyword list
 * would have skipped.
 */
function splitIntoCandidateBlocks(source: string): CandidateBlock[] {
  const pattern = /(?:function|modifier)\s+(\w+)[^{]*\{/g;
  const blocks: CandidateBlock[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null && blocks.length < MAX_CANDIDATES) {
    const start = match.index;
    const end = findMatchingBrace(source, start + match[0].length - 1);
    if (end === null) continue;
    blocks.push({ name: match[1], body: truncate(source.substring(start, end + 1)) });
  }
  return blocks;
}

// ─── Step 2: rubric prompt + contrastive few-shot pairs ──────────────────────

const RUBRIC_SYSTEM_PROMPT = `You are an expert Solidity security auditor. You will be given a list of function/modifier bodies extracted from a verified ERC-20 token contract on Base. For EACH one, decide whether it represents a rug-pull risk (owner backdoor, hidden fee/tax control, trading pause/blacklist mechanism, hidden mint, supply/tx manipulation, or a hidden secondary privileged address).

Judge substance, not surface keywords. A function is not suspicious merely because it contains a word like "pause" or "fee" — judge what it actually DOES and WHO it privileges. Two functions can look superficially similar and have opposite risk: a cooldown applied equally to every address is normal anti-bot protection; a cooldown that exempts an owner-controlled address list is a rug lever.

For EACH function, reason through these steps IN ORDER, then give a verdict. Do not skip to a verdict without filling in every step:

1. mechanicalEffect — what does this code concretely change or do, in plain terms? Ignore the function's name; read the logic.
2. accessControl — who can actually call this / what gates its execution (public and ungated, owner-only, role-gated, a hardcoded address check, etc.)?
3. userImpact — if this path executes, what concretely happens to a normal trader or holder who is not the deployer?
4. precedentMatch — does this resemble a known BENIGN pattern or a known MALICIOUS pattern from the examples below? Name which one, or say "novel" if it matches neither.
5. Only after 1–4: suspicious (boolean), severity, confidence (0–1, your genuine certainty in THIS verdict), reasoning (one paragraph tying 1–4 to the verdict).

Also set secondaryAdminCandidate=true on a function if AND ONLY IF: ownership has been renounced (see input) AND this function's access control references a privileged address variable that is NOT the renounced owner — i.e. it looks like a hidden second admin surviving the renounce.

CONTRASTIVE EXAMPLES (study the difference in reasoning, not just the code shape):

Example A — BENIGN: a transfer cooldown
\`\`\`
function _checkCooldown(address from) internal view {
    require(block.timestamp >= lastTx[from] + 60, "cooldown");
}
\`\`\`
mechanicalEffect: blocks any address from transferring more than once per 60 seconds.
accessControl: applies to every address uniformly; no exemption list.
userImpact: minor inconvenience during high-frequency trading; does not block selling entirely, does not target specific users.
precedentMatch: benign anti-bot cooldown, applied uniformly.
verdict: suspicious=false, severity=LOW, confidence=0.85.

Example B — MALICIOUS: a transfer cooldown with an exemption
\`\`\`
function _checkCooldown(address from) internal view {
    if (isExempt[from]) return;
    require(block.timestamp >= lastTx[from] + 60, "cooldown");
}
\`\`\`
mechanicalEffect: same cooldown logic, EXCEPT addresses in isExempt bypass it entirely.
accessControl: isExempt is settable by the owner (assume standard pattern unless shown otherwise) — this creates a two-tier system.
userImpact: ordinary holders are throttled; owner-controlled/insider addresses can trade freely, e.g. to dump before others can react.
precedentMatch: malicious selective-cooldown / insider-exemption pattern.
verdict: suspicious=true, severity=HIGH, confidence=0.8.

Example C — BENIGN: standard Ownable pause used defensively
\`\`\`
function pause() external onlyOwner { _paused = true; }
\`\`\`
On its own, a pause gated only by onlyOwner is ambiguous — flag it as suspicious=true, severity=MEDIUM, confidence around 0.4–0.5, and say so explicitly: pause functions are a common LEGITIMATE emergency-stop pattern but are also a common rug lever (freeze trading while dumping). Do not claim high confidence either way without more context such as whether the pause blocks selling specifically or all transfers, or whether it is time-limited.

Example D — MALICIOUS: mint after renounce, hidden second admin
\`\`\`
address private _op;
function setOp(address a) external { require(msg.sender == _op, "no"); _op = a; }
function emergencyMint(address to, uint256 amt) external { require(msg.sender == _op, "no"); _mint(to, amt); }
\`\`\`
mechanicalEffect: emergencyMint creates new tokens to an arbitrary address.
accessControl: gated by _op, a separate address variable — NOT the contract's owner().
userImpact: if ownership was renounced, holders would reasonably believe no one can mint further — but _op can mint arbitrarily, diluting all holders.
precedentMatch: hidden secondary admin surviving ownership renounce — classic renounce decoy.
verdict: suspicious=true, severity=CRITICAL, confidence=0.85, secondaryAdminCandidate=true (if ownership is renounced in the input).

IMPORTANT RULES:
1. Return ONLY valid JSON — no markdown, no prose, no code fences.
2. Only use severity values: "LOW", "MEDIUM", "HIGH", "CRITICAL".
3. confidence must be a number between 0 and 1. Be honest — do not default to 0.9 out of habit. Ambiguous patterns (like Example C) deserve mid-range confidence.
4. Do not invent functions that were not given to you. Return exactly one verdict object per input function, in the same order, using the exact "name".
5. secondaryAdminCandidate must be false unless the input explicitly states ownership is renounced AND you found a separate privileged address as described above.

Required JSON output shape:
{
  "functions": [
    {
      "name": <string, must match an input function name exactly>,
      "mechanicalEffect": <string>,
      "accessControl": <string>,
      "userImpact": <string>,
      "precedentMatch": <string>,
      "suspicious": <boolean>,
      "severity": <"LOW"|"MEDIUM"|"HIGH"|"CRITICAL">,
      "confidence": <number 0-1>,
      "reasoning": <string>,
      "secondaryAdminCandidate": <boolean>
    }
  ]
}`;

// ─── Step 3: strict validation ────────────────────────────────────────────────

const VALID_SEVERITIES = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

function validateFunctionVerdict(
  raw: unknown,
  snippetByName: Map<string, string>
): FunctionAudit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.name !== "string" || !snippetByName.has(r.name)) return null;
  if (typeof r.mechanicalEffect !== "string" || r.mechanicalEffect.trim().length === 0) return null;
  if (typeof r.accessControl !== "string" || r.accessControl.trim().length === 0) return null;
  if (typeof r.userImpact !== "string" || r.userImpact.trim().length === 0) return null;
  if (typeof r.precedentMatch !== "string" || r.precedentMatch.trim().length === 0) return null;
  if (typeof r.suspicious !== "boolean") return null;
  if (typeof r.severity !== "string" || !VALID_SEVERITIES.has(r.severity)) return null;
  if (typeof r.confidence !== "number" || r.confidence < 0 || r.confidence > 1) return null;
  if (typeof r.reasoning !== "string" || r.reasoning.trim().length === 0) return null;
  const secondaryAdminCandidate = typeof r.secondaryAdminCandidate === "boolean" ? r.secondaryAdminCandidate : false;

  return {
    name: r.name,
    mechanicalEffect: r.mechanicalEffect,
    accessControl: r.accessControl,
    userImpact: r.userImpact,
    precedentMatch: r.precedentMatch,
    suspicious: r.suspicious,
    severity: r.severity as FunctionAudit["severity"],
    confidence: r.confidence,
    reasoning: r.reasoning,
    snippet: snippetByName.get(r.name) ?? "",
    secondaryAdminCandidate,
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────
//
// NOTE: there is intentionally no keyword-grep fallback. If the LLM audit
// cannot produce a trustworthy verdict — missing API key, network failure,
// non-2xx response, unparseable JSON, or a response that fails validation —
// this throws rather than silently downgrading to a much weaker heuristic.
// A caller that swallows this error and treats a token as "clean" is a worse
// outcome than a visible failure; callers should let this propagate (or
// explicitly decide how to handle "source audit unavailable" themselves)
// rather than have that decision made silently in here.

export async function analyzeSourceWithLLM(
  source: string,
  ownershipRenounced: boolean | null,
  ownerAddress: string | null,
  warnings: string[]
): Promise<SourceAuditResult> {
  const key = cacheKey(source, ownershipRenounced, ownerAddress);
  const cached = sourceAuditCache.get(key);
  if (cached) {
    console.log(`  [sourceAudit] cache hit (${cached.method}) — skipping Gemini call`);
    return cached;
  }

  const candidates = splitIntoCandidateBlocks(source);

  if (candidates.length === 0) {
    const result: SourceAuditResult = { suspiciousFunctions: [], secondaryAdminDetected: false, secondaryAdminSnippet: null, method: "llm", functionAudits: [] };
    sourceAuditCache.set(key, result);
    return result;
  }

  if (!GEMINI_API_KEY) {
    throw new Error("[sourceAudit] GEMINI_API_KEY not set — cannot run source audit");
  }

  const snippetByName = new Map(candidates.map((c) => [c.name, c.body]));

  const userMessage =
    `ownershipRenounced: ${ownershipRenounced === null ? "unknown" : ownershipRenounced}\n` +
    `ownerAddress: ${ownerAddress ?? "unknown"}\n\n` +
    `Audit the following ${candidates.length} function(s)/modifier(s). Return exactly ${candidates.length} verdict objects, one per function, in the same order, using the exact "name" given.\n\n` +
    candidates.map((c, i) => `--- function ${i + 1}: ${c.name} ---\n${c.body}`).join("\n\n");

  let rawModelText = "";
  try {
    rawModelText = await callGeminiText(
      RUBRIC_SYSTEM_PROMPT,
      "Understood. I will reason through steps 1–4 for every function before giving a verdict, and return only valid JSON in the specified shape.",
      userMessage,
      "source-audit"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[sourceAudit] ${msg}`);
  }

  const cleaned = stripJsonFences(rawModelText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`[sourceAudit] Model returned non-JSON response: ${cleaned.slice(0, 200)}`);
  }

  const parsedFunctions = (parsed as Record<string, unknown>)?.functions;
  if (!Array.isArray(parsedFunctions) || parsedFunctions.length === 0) {
    throw new Error("[sourceAudit] Model response missing/empty 'functions' array");
  }

  // Validate each item independently — drop malformed items rather than
  // discarding the whole batch, but track how many were dropped.
  const functionAudits: FunctionAudit[] = [];
  let droppedCount = 0;
  for (const item of parsedFunctions) {
    const verdict = validateFunctionVerdict(item, snippetByName);
    if (verdict) functionAudits.push(verdict);
    else droppedCount++;
  }

  if (droppedCount > 0) {
    warnings.push(`[sourceAudit] ${droppedCount} of ${parsedFunctions.length} function verdicts failed validation and were dropped`);
  }

  // If EVERYTHING was dropped, that's effectively a total failure.
  if (functionAudits.length === 0) {
    throw new Error("[sourceAudit] All function verdicts failed validation");
  }

  const confident = functionAudits.filter((f) => f.confidence >= CONFIDENCE_THRESHOLD);
  const lowConfidenceCount = functionAudits.length - confident.length;
  if (lowConfidenceCount > 0) {
    warnings.push(`[sourceAudit] ${lowConfidenceCount} finding(s) below confidence threshold (${CONFIDENCE_THRESHOLD}) — excluded from scoring, kept in functionAudits for review`);
  }

  const suspiciousFunctions = confident
    .filter((f) => f.suspicious)
    .map((f) => ({ name: f.name, snippet: f.snippet }));

  const secondaryAdminHit = confident.find((f) => f.secondaryAdminCandidate === true);

  const result: SourceAuditResult = {
    suspiciousFunctions,
    secondaryAdminDetected: secondaryAdminHit !== undefined,
    secondaryAdminSnippet: secondaryAdminHit ? secondaryAdminHit.snippet : null,
    method: "llm",
    functionAudits,
  };
  sourceAuditCache.set(key, result);
  return result;
}
