import type { Address } from "viem";

// ─── Core types ───────────────────────────────────────────────────────────────

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface RiskFlag {
  id: string;          // machine-readable key
  label: string;       // short human label
  detail: string;      // evidence sentence shown in the report
  severity: RiskLevel;
  points: number;      // used by rule engine; LLM sets 0 but field is required
}

export interface RugCheckResult {
  tokenAddress: Address;
  poolAddress: Address;
  pairedAsset: string;

  // ── Ownership ──────────────────────────────────────────────────────────────
  ownerAddress: string;
  ownershipRenounced: boolean;
  isProxy: boolean | null;          // null = storage read failed

  // ── Supply / dev wallet ────────────────────────────────────────────────────
  totalSupply: bigint;
  decimals: number;
  deployerAddress: string;
  deployerBalance: bigint;
  deployerBalanceIsEstimate: boolean;
  deployerPct: number | null;        // null = unverified (not "0%")
  top5HoldersPct: number | null;     // null = unverified (not "0%")

  // ── Liquidity ──────────────────────────────────────────────────────────────
  poolLiquidity: bigint | null;      // null = read failed; 0n = confirmed empty
  initialLiquidityEth: number;
  liquidityLocked: boolean | null;   // null = unknown

  // ── New evidence fields ────────────────────────────────────────────────────
  sellTestPassed: boolean | null;
  sellTestAmountSent: string | null;
  sellTestError: string | null;
  lpTokenId: string | null;
  lpPositionOwner: string | null;
  lpPositionStatus: "burned" | "locked_uncx" | "held_by_eoa" | "non_nft_position" | "unverified";
  liquidityEverPulled: boolean;
  burnEventCount: number;
  sourceVerified: boolean | null;
  suspiciousFunctions: string[];
  deployerSeenBefore: boolean;
  deployerPriorTokens: string[];

  // ── Scoring ────────────────────────────────────────────────────────────────
  flags: RiskFlag[];
  score: number;                     // 0 (safe) → 100 (certain rug)
  verdict: RiskLevel;
  summary: string;

  // ── Metadata ───────────────────────────────────────────────────────────────
  scoringMethod?: "rules" | "llm";
  scoringError?: string;             // set when LLM scoring fails
  /** Direct answer to the user's question, only present when asked via chat */
  answer?: string;
}
