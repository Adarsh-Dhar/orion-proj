/**
 * scoring.ts — deterministic, continuous rug-risk scorer.
 *
 * WHY THIS EXISTS:
 * llm-score.ts used to ask Gemini for a final integer 0-100. LLMs reliably
 * output round, "clean" numbers (85, 65, 45...) regardless of how granular
 * the underlying evidence is, so many unrelated tokens ended up sharing the
 * exact same score, and a chunk of "100"s were actually just LLM failures
 * being force-defaulted to max risk.
 *
 * This module replaces that step. The LLM (see llm-score.ts) still decides
 * WHICH qualitative risk flags apply and writes the human-readable detail
 * sentences — that's a judgment call it's good at. But the actual number is
 * computed here, deterministically, in code, as a continuous function of
 * the real evidence values (percentages, ETH amounts, ratios) rather than
 * fixed point buckets. Two tokens that trip the "same" flags will still get
 * different scores because their underlying numbers differ.
 *
 * The output is a float with 2 decimal places, e.g. 87.43, not an integer.
 */

import type { TokenEvidence } from "./evidence.js";
import type { RiskFlag, RiskLevel } from "./rugcheck-types.js";
import type { ComputedScore } from "./utils/interface.js";


// ─── Smoothing helpers ────────────────────────────────────────────────────────

/** Clamp x to [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Linear ramp from 0 to 1 between [from, to]. */
function ramp(x: number, from: number, to: number): number {
  if (to === from) return x >= to ? 1 : 0;
  return clamp((x - from) / (to - from), 0, 1);
}

/** Exponential decay toward 1 as x -> 0 (used for "the less liquidity, the worse"). */
function decay(x: number, halfLife: number): number {
  return Math.exp(-x / halfLife);
}

// ─── Individual factor scorers ────────────────────────────────────────────────
// Each returns { points, detail } where points is already scaled by its max weight.

function scoreDevWallet(pct: number | null): { points: number; note: string } {
  if (pct === null) return { points: 10, note: "Dev wallet balance unverifiable (+10, treated as risk)" };
  const t = ramp(pct, 5, 100);
  const points = 40 * Math.pow(t, 0.6);
  return { points, note: `Dev wallet holds ${pct.toFixed(2)}% of supply` };
}

function scoreTop5Holders(pct: number | null): { points: number; note: string } {
  if (pct === null) return { points: 10, note: "Top-5 holder data unverifiable (+10)" };
  const t = ramp(pct, 40, 100);
  const points = 20 * t;
  return { points, note: `Top-5 holders control ${pct.toFixed(2)}% of supply` };
}

function scoreLiquidity(hasLiquidity: boolean, eth: number | null): { points: number; note: string } {
  // A pool that genuinely has zero liquidity yet (brand-new token, LP add
  // hasn't landed) is NOT the same thing as a pool that had liquidity and
  // it's now unverifiable/zero — the former is expected and re-checked by
  // reVerifyEvidence() as the pool matures, the latter is a real risk signal.
  if (!hasLiquidity) return { points: 0, note: "Liquidity pending — no pool liquidity yet (new token, re-checked automatically)" };
  if (eth === null) return { points: 15, note: "Liquidity unverifiable (+15)" };
  const points = 40 * decay(eth, 0.3);
  return { points, note: `Initial liquidity ≈ ${eth.toFixed(4)} ETH` };
}

function scoreLiquidityDelta(hasLiquidity: boolean, deltaPct: number | null): { points: number; note: string } | null {
  if (!hasLiquidity) return null; // nothing to compare a delta against yet
  if (deltaPct === null) return null;
  if (deltaPct >= 0) return null;
  const drop = Math.abs(deltaPct);
  if (drop < 30) return null;
  const t = ramp(drop, 30, 100);
  const points = 50 * t;
  return { points, note: `Liquidity dropped ${drop.toFixed(2)}% since last snapshot` };
}

function scoreSerialDeployer(seenBefore: boolean, priorTokens: string[]): { points: number; note: string } | null {
  if (!seenBefore) return null;
  const count = priorTokens.length;
  if (count === 0) {
    return { points: 10, note: "Deployer seen before (pattern risk)" };
  }
  const t = ramp(count, 0, 6);
  const points = 20 * t;
  return { points, note: `Deployer has ${count} prior token${count === 1 ? "" : "s"} on record` };
}

function scoreOwnership(renounced: boolean | null, hasLiquidity: boolean): { points: number; note: string } {
  if (renounced === null) return { points: 10, note: "Ownership status unverifiable (+10)" };
  if (renounced === false) {
    // Renouncing ownership before liquidity even exists is unusual, not
    // standard practice — most legitimate deployers renounce (if at all)
    // after launch. Don't score "not yet renounced" as risk on a token
    // that's minutes old; the privileges the owner role actually has
    // (mint, blacklist, fee-setting, etc.) are what matters, and that's
    // captured by the source audit's suspicious-function flags instead.
    if (!hasLiquidity) {
      return { points: 3, note: "Ownership not renounced (expected pre-launch — owner privileges audited separately)" };
    }
    return { points: 25, note: "Ownership not renounced (active owner)" };
  }
  return { points: 0, note: "Ownership renounced" };
}

function scoreProxy(isProxy: boolean | null): { points: number; note: string } {
  if (isProxy === null) return { points: 10, note: "Proxy status unverifiable (+10)" };
  if (isProxy === true) return { points: 35, note: "Upgradeable proxy detected — implementation-swap risk" };
  return { points: 0, note: "Not a proxy contract" };
}

function scoreSellTest(hasLiquidity: boolean, passed: boolean | null): { points: number; note: string } {
  if (!hasLiquidity) return { points: 0, note: "Sell test pending — no liquidity to simulate a swap against yet" };
  if (passed === null) return { points: 5, note: "Sell test inconclusive (no suitable holder) (+5)" };
  if (passed === false) return { points: 50, note: "Sell test FAILED — confirmed honeypot" };
  return { points: 0, note: "Sell test passed" };
}

function scoreLpPosition(hasLiquidity: boolean, status: TokenEvidence["lpPositionStatus"]): { points: number; note: string } {
  if (!hasLiquidity && status === "unverified") {
    return { points: 0, note: "LP lock status pending — no Mint/ModifyLiquidity event yet (new token)" };
  }
  switch (status) {
    case "burned":         return { points: 0,  note: "LP position burned (liquidity locked forever)" };
    case "locked_uncx":    return { points: 0,  note: "LP position locked via UNCX" };
    case "held_by_eoa":    return { points: 25, note: "LP position held by an EOA (not locked)" };
    case "non_nft_position": return { points: 10, note: "LP position is a non-NFT position (unusual)" };
    case "unverified":
    default:               return { points: 10, note: "LP lock status unverifiable (+10)" };
  }
}

function scoreLiquidityPulled(hasLiquidity: boolean, everPulled: boolean, burnEvents: number): { points: number; note: string } | null {
  if (!hasLiquidity) return null; // nothing to have pulled yet
  if (!everPulled) return null;
  const t = ramp(burnEvents, 1, 5);
  const points = 30 + 10 * t; // 30..40
  return { points, note: `Liquidity pulled at least once (${burnEvents} burn event${burnEvents === 1 ? "" : "s"})` };
}

function scoreSourceVerification(
  verified: boolean | null,
  hasLiquidity: boolean
): { points: number; note: string } | null {
  if (verified === null) return { points: 5, note: "Source verification API call failed (+5, inconclusive)" };
  if (verified === false) {
    // Pre-liquidity, source verification is the single strongest signal
    // available (no trading history exists yet to fall back on), and
    // legitimate deployers overwhelmingly verify immediately — so weight
    // an unverified contract more heavily on a token this fresh.
    return hasLiquidity
      ? { points: 15, note: "Source code not verified" }
      : { points: 30, note: "Source code not verified (new token — no fallback trading-history signal either)" };
  }
  return null;
}

function scoreDeployerVelocity(deploysLastHour: number, deploysLast24h: number): { points: number; note: string } | null {
  if (deploysLastHour >= 5) {
    return { points: 35, note: `Deployer created ${deploysLastHour} contracts in the last hour (factory/serial pattern)` };
  }
  if (deploysLast24h >= 3) {
    return { points: 20, note: `Deployer created ${deploysLast24h} contracts in the last 24 h (serial deployer)` };
  }
  return null;
}

function scoreWalletAge(
  walletAgeAtDeploySeconds: number | null,
  fundingGapSeconds: number | null
): { points: number; note: string } | null {
  if (walletAgeAtDeploySeconds !== null && walletAgeAtDeploySeconds < 600) {
    return { points: 25, note: `Deployer wallet was only ${walletAgeAtDeploySeconds}s old at deploy time (disposable wallet pattern)` };
  }
  if (fundingGapSeconds !== null && fundingGapSeconds < 120) {
    return { points: 15, note: `Deployer wallet was funded only ${fundingGapSeconds}s before deploy (purpose-built funding pattern)` };
  }
  return null;
}

function scorePreSeededWallets(
  preSeededWallets: string[],
  preSeededPct: number | null
): { points: number; note: string } | null {
  if (preSeededWallets.length === 0) return null;
  const points = clamp(10 * preSeededWallets.length, 0, 40);
  const pctPart = preSeededPct !== null ? ` (currently hold ${preSeededPct.toFixed(2)}% of supply)` : "";
  return {
    points,
    note: `${preSeededWallets.length} wallet${preSeededWallets.length === 1 ? "" : "s"} received tokens before liquidity was added${pctPart}`,
  };
}

function scoreProxyImplementationAudit(evidence: TokenEvidence): { points: number; note: string } | null {
  if (!evidence.isProxy) return null;
  if (evidence.sourceVerified && !evidence.proxyImplementationAudited) {
    // We audited the proxy shim, not the real logic contract — the clean
    // result above is not meaningful on its own.
    return { points: 15, note: "Proxy implementation contract not independently verified/audited" };
  }
  return null;
}

function scoreSuspiciousFunctions(fns: { name: string; snippet: string }[]): { points: number; note: string } | null {
  if (fns.length === 0) return null;
  const points = clamp(15 * fns.length, 0, 45);
  return { points, note: `${fns.length} suspicious function${fns.length === 1 ? "" : "s"} found in source` };
}

function scoreSecondaryAdmin(detected: boolean): { points: number; note: string } | null {
  if (!detected) return null;
  return { points: 30, note: "Secondary privileged role found despite renounced ownership" };
}

function scoreWashTrading(evidence: TokenEvidence): Array<{ points: number; note: string }> {
  const out: Array<{ points: number; note: string }> = [];
  // No liquidity yet ⇒ no swaps are possible, so an empty/partial trade scan
  // is expected rather than a real gap in evidence.
  if (!evidence.hasLiquidity) return out;

  if (evidence.roundTripTraderPct !== null && evidence.roundTripTraderPct > 40) {
    const t = ramp(evidence.roundTripTraderPct, 40, 100);
    out.push({ points: 25 * t, note: `${evidence.roundTripTraderPct.toFixed(2)}% of traders round-tripped (wash-trading pattern)` });
  }

  if (evidence.topTraderSwapSharePct > 50) {
    const t = ramp(evidence.topTraderSwapSharePct, 50, 100);
    out.push({ points: 30 * t, note: `Single trader responsible for ${evidence.topTraderSwapSharePct.toFixed(2)}% of swap volume` });
  }

  if (evidence.uniqueTraders < 5 && evidence.totalSwaps > 20) {
    out.push({ points: 20, note: `Only ${evidence.uniqueTraders} unique traders across ${evidence.totalSwaps} swaps (thin/bot activity)` });
  }

  if (evidence.buySellRatio !== null && evidence.buySellRatio < 0.5) {
    const t = ramp(0.5 - evidence.buySellRatio, 0, 0.5);
    out.push({ points: 15 * t, note: `Buy/sell ratio skewed toward sells (${evidence.buySellRatio.toFixed(2)})` });
  }

  if (evidence.tradeScanPartial) {
    out.push({ points: 10, note: "Trade scan data incomplete (+10)" });
  }

  return out;
}

function scoreV4Hook(evidence: TokenEvidence): Array<{ points: number; note: string }> {
  const out: Array<{ points: number; note: string }> = [];
  const NULL_HOOK = "0x0000000000000000000000000000000000000000";
  if (evidence.venue === "v4" && evidence.hookAddress && evidence.hookAddress.toLowerCase() !== NULL_HOOK) {
    out.push({ points: 20, note: `Custom V4 hook attached (${evidence.hookAddress})` });
    if (evidence.sourceVerified === false || evidence.sourceVerified === null) {
      out.push({ points: 15, note: "V4 hook source not independently verified" });
    }
  }
  return out;
}

function scoreSanity(evidence: TokenEvidence): Array<{ points: number; note: string }> {
  const out: Array<{ points: number; note: string }> = [];

  if (evidence.totalSupply === "0") {
    out.push({ points: 20, note: "Total supply is zero (broken contract)" });
  }

  const unverifiedCount = [
    evidence.ownershipRenounced === null,
    evidence.isProxy === null,
    evidence.deployerPct === null,
    evidence.top5HoldersPct === null,
    // Liquidity/sell-test being null is expected (not a gap) on a token
    // that genuinely has no liquidity yet — only count it when liquidity
    // exists and the read still failed.
    evidence.hasLiquidity && evidence.poolLiquidity === null,
    evidence.hasLiquidity && evidence.sellTestPassed === null,
    evidence.sourceVerified === null,
  ].filter(Boolean).length;

  if (unverifiedCount >= 3) {
    out.push({ points: 10, note: `${unverifiedCount} evidence fields unverifiable (compound uncertainty)` });
  }

  if (evidence.rpcWarnings.length > 0) {
    const t = ramp(evidence.rpcWarnings.length, 1, 10);
    out.push({ points: 5 * t, note: `${evidence.rpcWarnings.length} RPC warning(s) during evidence collection` });
  }

  return out;
}

// ─── Verdict bucketing (unchanged thresholds, applied to the final float) ─────

function verdictFor(score: number): RiskLevel {
  if (score >= 75) return "CRITICAL";
  if (score >= 50) return "HIGH";
  if (score >= 25) return "MEDIUM";
  return "LOW";
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function computeScore(evidence: TokenEvidence): ComputedScore {
  const breakdown: Array<{ id: string; label: string; contribution: number }> = [];
  let total = 0;

  function add(id: string, result: { points: number; note: string } | null) {
    if (!result) return;
    total += result.points;
    breakdown.push({ id, label: result.note, contribution: Number(result.points.toFixed(2)) });
  }

  const hasLiquidity = evidence.hasLiquidity;

  add("dev_wallet", scoreDevWallet(evidence.deployerPct));
  add("top5_holders", scoreTop5Holders(evidence.top5HoldersPct));
  add("liquidity", scoreLiquidity(hasLiquidity, evidence.initialLiquidityEth));
  add("liquidity_delta", scoreLiquidityDelta(hasLiquidity, evidence.liquidityDeltaPct));
  add("serial_deployer", scoreSerialDeployer(evidence.deployerSeenBefore, evidence.deployerPriorTokens));
  add("deployer_velocity", scoreDeployerVelocity(evidence.deploysLastHour, evidence.deploysLast24h));
  add("wallet_age", scoreWalletAge(evidence.walletAgeAtDeploySeconds, evidence.fundingGapSeconds));
  add("pre_seeded_wallets", scorePreSeededWallets(evidence.preSeededWallets, evidence.preSeededPct));
  add("ownership", scoreOwnership(evidence.ownershipRenounced, hasLiquidity));
  add("proxy", scoreProxy(evidence.isProxy));
  add("proxy_implementation", scoreProxyImplementationAudit(evidence));
  add("sell_test", scoreSellTest(hasLiquidity, evidence.sellTestPassed));
  add("lp_position", scoreLpPosition(hasLiquidity, evidence.lpPositionStatus));
  add("liquidity_pulled", scoreLiquidityPulled(hasLiquidity, evidence.liquidityEverPulled, evidence.burnEventCount));
  add("source_verification", scoreSourceVerification(evidence.sourceVerified, hasLiquidity));
  add("suspicious_functions", scoreSuspiciousFunctions(evidence.suspiciousFunctions));
  add("secondary_admin", scoreSecondaryAdmin(evidence.secondaryAdminDetected));

  for (const w of scoreWashTrading(evidence)) {
    total += w.points;
    breakdown.push({ id: "wash_trading", label: w.note, contribution: Number(w.points.toFixed(2)) });
  }
  for (const h of scoreV4Hook(evidence)) {
    total += h.points;
    breakdown.push({ id: "v4_hook", label: h.note, contribution: Number(h.points.toFixed(2)) });
  }
  for (const s of scoreSanity(evidence)) {
    total += s.points;
    breakdown.push({ id: "sanity", label: s.note, contribution: Number(s.points.toFixed(2)) });
  }

  const finalScore = Number(clamp(total, 0, 100).toFixed(2));

  return {
    score: finalScore,
    verdict: verdictFor(finalScore),
    breakdown,
  };
}

export function attachComputedScore(
  evidence: TokenEvidence,
  llmFlags: RiskFlag[]
): { score: number; verdict: RiskLevel; flags: RiskFlag[]; breakdown: ComputedScore["breakdown"] } {
  const computed = computeScore(evidence);
  return {
    score: computed.score,
    verdict: computed.verdict,
    flags: llmFlags,
    breakdown: computed.breakdown,
  };
}