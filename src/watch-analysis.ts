/**
 * watch-analysis.ts — Continuously re-checks a single stored analysis and
 * patches it in place as fresher on-chain data becomes available.
 *
 * This is a long-running process (like the Telegram bot) — it does NOT exit
 * on its own. Stop it with Ctrl+C.
 *
 * What it does on every tick:
 *   1. Loads the analysis record from Redis by ID.
 *   2. Re-runs the lightweight LP-lock / pool-liquidity re-check
 *      (evidence.ts:reVerifyEvidence — the same function the scan engine
 *      uses for its one-shot 3-minute recheck, just run repeatedly here).
 *   3. Retries Etherscan source verification if it previously came back
 *      null/false (transient Etherscan/RPC failures are common right after
 *      a token launches).
 *   4. If anything changed, deep-merges the patch into evidence and
 *      recomputes score/verdict/breakdown deterministically via
 *      scoring.ts:computeScore (no LLM call — cheap enough to run every tick).
 *
 * It never rewrites flags[] (those are the LLM's qualitative read from the
 * original pass) or holder/trade-activity data (expensive scans that don't
 * meaningfully change tick-to-tick) — only the fields that are known to
 * start "unverified" and settle within minutes.
 *
 * Usage:
 *   npm run watch-analysis -- <analysisId> [intervalSeconds]
 *
 * Example:
 *   npm run watch-analysis -- 1787387514392-B2000000 30
 */

import "dotenv/config";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import {
  getAnalysis,
  updateAnalysis,
} from "./lib/analysis-store.js";
import type { StoredAnalysis } from "./lib/utils/interface.js";
import { reVerifyEvidence, checkSourceVerification, type TokenEvidence } from "./lib/evidence.js";
import { computeScore } from "./lib/scoring.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

// ─── CLI args ──────────────────────────────────────────────────────────────

const analysisId = process.argv[2];
const intervalSeconds = Number(process.argv[3] ?? 60);

if (!analysisId) {
  console.error("Usage: npm run watch-analysis -- <analysisId> [intervalSeconds]");
  process.exit(1);
}
if (!process.env.RPC_URL) {
  console.error("RPC_URL is not set — copy .env.example to .env and fill it in first.");
  process.exit(1);
}

const intervalMs = Math.max(5, intervalSeconds) * 1000;

const client = createPublicClient({
  chain: base,
  transport: http(process.env.RPC_URL),
});

// ─── One tick ──────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  const stamp = new Date().toISOString();
  const analysis: StoredAnalysis | null = await getAnalysis(analysisId);

  if (!analysis) {
    console.error(`[${stamp}] analysis ${analysisId} not found — is UPSTASH_REDIS_REST_URL/TOKEN set?`);
    return;
  }

  const evidence = analysis.evidence;
  const venue = analysis.venue ?? evidence.venue ?? "v3";
  const deployBlock = BigInt(evidence.deployBlock ?? "0");

  console.log(`[${stamp}] checking ${analysis.tokenSymbol} (${analysis.tokenAddress})…`);

  const evidencePatch: Partial<TokenEvidence> = {};
  let changed = false;

  // ── 1. LP lock + pool liquidity ──────────────────────────────────────────
  try {
    const recheck = await reVerifyEvidence(client as AnyClient, evidence, deployBlock, venue);
    if (recheck.improved) {
      if (recheck.lpPositionStatus !== undefined) {
        evidencePatch.lpPositionStatus = recheck.lpPositionStatus;
        evidencePatch.lpTokenId = recheck.lpTokenId ?? null;
        evidencePatch.lpPositionOwner = recheck.lpPositionOwner ?? null;
      }
      if (recheck.poolLiquidity !== undefined) {
        evidencePatch.poolLiquidity = recheck.poolLiquidity ?? null;
        evidencePatch.initialLiquidityEth = recheck.initialLiquidityEth ?? null;
        evidencePatch.liquidityLocked = recheck.liquidityLocked ?? null;
      }
      changed = true;
      console.log(`  → LP/liquidity improved`);
    }
  } catch (err) {
    console.error(`  LP/liquidity recheck failed: ${err}`);
  }

  // ── 2. Source verification retry ─────────────────────────────────────────
  if (evidence.sourceVerified === null || evidence.sourceVerified === false) {
    try {
      const srcCheck = await checkSourceVerification(
        analysis.tokenAddress as Address,
        [],
        evidence.ownershipRenounced,
        evidence.ownerAddress
      );
      if (srcCheck.sourceVerified !== null && srcCheck.sourceVerified !== evidence.sourceVerified) {
        evidencePatch.sourceVerified = srcCheck.sourceVerified;
        evidencePatch.suspiciousFunctions = srcCheck.suspiciousFunctions;
        evidencePatch.secondaryAdminDetected = srcCheck.secondaryAdminDetected;
        evidencePatch.secondaryAdminSnippet = srcCheck.secondaryAdminSnippet;
        changed = true;
        console.log(`  → source verification improved: ${evidence.sourceVerified} → ${srcCheck.sourceVerified}`);
      }
    } catch (err) {
      console.error(`  source verification recheck failed: ${err}`);
    }
  }

  if (!changed) {
    console.log(`  no change`);
    return;
  }

  // ── 3. Recompute score/verdict from the merged evidence ─────────────────
  const mergedEvidence: TokenEvidence = { ...evidence, ...evidencePatch };
  const computed = computeScore(mergedEvidence);

  const ok = await updateAnalysis(analysisId, {
    evidencePatch,
    score: computed.score,
    verdict: computed.verdict,
    scoreBreakdown: computed.breakdown,
  });

  console.log(
    ok
      ? `  ✅ patched — score ${analysis.score.toFixed(2)} → ${computed.score.toFixed(2)}, verdict ${analysis.verdict} → ${computed.verdict}`
      : `  ⚠️ update failed`
  );
}

// ─── Main loop ─────────────────────────────────────────────────────────────

console.log(`[watch-analysis] watching ${analysisId} every ${intervalSeconds}s. Ctrl+C to stop.`);
console.log(`[watch-analysis] page: ${process.env.FRONTEND_BASE_URL ?? "http://localhost:3000"}/analysis/${analysisId}`);

tick();
setInterval(tick, intervalMs);
