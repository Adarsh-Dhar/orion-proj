/**
 * types.ts — frontend-side mirror of src/lib/evidence.ts (TokenEvidence) and
 * src/lib/rugcheck-types.ts (RiskFlag, ToolCallRecord).
 *
 * The frontend is a separate Next.js app from the bot backend (root /src),
 * so these types are duplicated here rather than imported across the package
 * boundary. Keep in sync with src/lib/evidence.ts and src/lib/rugcheck-types.ts
 * if those shapes change.
 */

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface RiskFlag {
  id: string;
  label: string;
  detail: string;
  severity: RiskLevel;
  points: number;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  output: unknown;
  ts: number;
}

export interface TokenEvidence {
  tokenAddress: string;
  poolAddress: string;
  pairedAsset: string;
  venue: 'v3' | 'v4';
  /** V4 only: hook contract address from the Initialize event. null for V3 pools. */
  hookAddress: string | null;
  deployBlock: string;

  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  totalSupplyFormatted: string;

  ownerAddress: string | null;
  ownershipRenounced: boolean | null;
  isProxy: boolean | null;

  deployerAddress: string | null;
  deployerMintBlock: string | null;
  deployerMintAmount: string | null;
  deployerCurrentBalance: string | null;
  deployerPct: number | null;

  holderScanFrom: string;
  holderScanTo: string;
  holderScanPartial: boolean;
  holderScanFailed: boolean;
  top5Holders: Array<{ address: string; balance: string; pct: number }>;
  top5HoldersPct: number | null;

  poolLiquidity: string | null;
  liquidityLocked: boolean | null;
  initialLiquidityEth: number | null;

  liquidityDeltaPct: number | null;
  liquidityPreviousReading: string | null;
  snapshotAgeMinutes: number | null;

  sellTestPassed: boolean | null;
  sellTestAmountSent: string | null;
  sellTestError: string | null;

  lpTokenId: string | null;
  lpPositionOwner: string | null;
  lpPositionStatus: 'burned' | 'locked_uncx' | 'held_by_eoa' | 'non_nft_position' | 'unverified';

  liquidityEverPulled: boolean;
  burnEventCount: number;

  sourceVerified: boolean | null;
  suspiciousFunctions: { name: string; snippet: string }[];
  secondaryAdminDetected: boolean;
  secondaryAdminSnippet: string | null;

  deployerSeenBefore: boolean;
  deployerPriorTokens: string[];

  totalSwaps: number;
  uniqueTraders: number;
  buyCount: number;
  sellCount: number;
  buySellRatio: number | null;
  roundTripTraderCount: number;
  roundTripTraderPct: number | null;
  topTraderSwapSharePct: number;
  tradeScanPartial: boolean;

  rpcWarnings: string[];
}

export interface StoredAnalysis {
  id: string;
  timestamp: number;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  poolAddress: string;
  pairedAsset: string;
  /** 'v3' or 'v4' — which Uniswap architecture this pool is on */
  venue?: 'v3' | 'v4';
  /** V4 only: hook contract address. null / absent for V3. */
  hookAddress?: string | null;
  score: number;
  verdict: RiskLevel;
  summary: string;
  evidence?: TokenEvidence;
  toolCallTranscript?: ToolCallRecord[];
  flags: RiskFlag[];
  scoringMethod: string;
}
