import type { Address } from "viem";
import type { PublicClient } from "viem";
import type { RiskLevel, VerdictLevel, Venue } from "../rugcheck-types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

export interface IterationDecision {
  runningScore: number;
  bandProximity: "deep" | "boundary";
  unresolvedMandatory: string[];
  reason: string;
  action: "continue" | "stop";
  nextTool?: string;
}

export interface AgentLoopResult {
  result: LLMScoreResult;
  transcript: ToolCallRecord[];
}

export interface ToolContext {
  client: AnyClient;
  tokenAddress: Address;
  poolAddress: Address;
  deployBlock: bigint;
  state?: BotState;
  // Cached values from initial evidence collection
  ownershipRenounced: boolean | null;
  ownerAddress: string | null;
  isProxy: boolean | null;
}

export interface StoredAnalysis {
  id: string;
  timestamp: number;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  poolAddress: string;
  pairedAsset: string;
  /** Which Uniswap architecture the pool is on */
  venue?: "v3" | "v4";
  /** V4 only: hook contract address from the Initialize event */
  hookAddress?: string | null;
  score: number;
  verdict: string;
  summary: string;
  evidence: TokenEvidence;
  toolCallTranscript?: ToolCallRecord[];
  decisionTrace?: IterationDecision[];
  flags: RiskFlag[];
  scoringMethod: string;
  /** Per-factor breakdown of how the deterministic score (scoring.ts) was built,
   *  so the frontend can show why the score landed where it did, down to
   *  individual continuous contributions rather than flat flag buckets. */
  scoreBreakdown?: Array<{ id: string; label: string; contribution: number }>;
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  /** Total supply formatted as a human-readable string using decimals */
  totalSupplyFormatted: string;
}


export interface LiquiditySnapshot {
  liquidity: string;
  blockNumber: string;
  ts: number;
}

export interface WatchlistEntry {
  tokenAddress: string;
  poolAddress: string;
  pairedAsset: string;
  venue: Venue;
  firstPostedTimestamp: number;
}

export interface BotState {
  /** Lower-cased token addresses already auto-posted. */
  postedTokens: string[];
  /** Deployer history: maps lower-cased deployer address to array of token addresses they've deployed. */
  deployerHistory: Record<string, string[]>;
  /** Liquidity history: maps lower-cased pool address to array of snapshots. */
  liquidityHistory: Record<string, LiquiditySnapshot[]>;
  /** Watchlist: tokens to monitor for liquidity drops after initial posting. */
  watchlist: Record<string, WatchlistEntry>; // key: token address (lowercased)
  /** Last scanned block watermark (persisted to avoid re-scanning on restart) */
  lastScannedBlock: string | null;
}

export interface ComputedScore {
  score: number;         // 0–100, 2 decimal places
  verdict: RiskLevel;
  breakdown: Array<{ id: string; label: string; contribution: number }>;
}

export interface TokenSummary {
  name: string;
  symbol: string;
  address: string;
  verdict: string;
  score: number;
  flags: number;
  venue: Venue;
}

// ─── Core block-range scanner ─────────────────────────────────────────────────

export interface ScanResult {
  summary: TokenSummary[];
  /** Total PoolCreated events found */
  totalPools: number;
  /** Successfully rug-checked */
  processed: number;
  /** Skipped (ambiguous pair, metadata failure, etc.) */
  skipped: number;
}

/** Optional hooks passed to scanBlockRange */
export interface ScanOptions {
  /**
   * Called before evidence collection to check if a token should be skipped.
   * Return true to skip this token (e.g., already posted).
   */
  shouldSkip?: (tokenAddress: string, poolAddress: string, pairedAsset: string) => boolean;
  /**
   * Called once per token immediately after the rug-check report is printed.
   * Errors thrown here are caught and logged — they never abort the scan loop.
   */
  onResult?: (result: RugCheckResult, meta: {
    name: string; symbol: string; decimals: number;
    totalSupply: bigint; totalSupplyFormatted: string;
  }) => Promise<void>;
  /**
   * Bot state for persistent storage (e.g., deployer history).
   */
  state?: BotState;
}

export interface TokenIdentity {
  newToken: Address | null;   // null = skip this pool (see pairedLabel: "ambiguous" or "no-known-quote-asset")
  pairedWith: Address | null;
  pairedLabel: string;
}

export interface ResolvedPool {
  poolAddress: Address;
  pairedLabel: string;
  pairedAsset: Address; // Add the paired asset address for watchlist
  venue: Venue;
}

export interface TokenEvidence {
  // ── Identity ──────────────────────────────────────────────────────────────
  tokenAddress: string;
  poolAddress: string;   // V3: pool contract address; V4: bytes32 PoolId as hex
  pairedAsset: string;
  venue: Venue;
  deployBlock: string;   // bigint as string

  // ── V4-specific ───────────────────────────────────────────────────────────
  /** V4 only: the hook contract address attached to this pool. address(0) means
   *  no hook.  Populated from the Initialize event; null for V3 pools. */
  hookAddress: string | null;

  // ── ERC-20 metadata ───────────────────────────────────────────────────────
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;           // bigint as string
  totalSupplyFormatted: string;  // human-readable with decimals

  // ── Ownership ─────────────────────────────────────────────────────────────
  ownerAddress: string | null;   // null = call failed
  ownershipRenounced: boolean | null;
  isProxy: boolean | null;       // null = storage read failed

  // ── Deployer / wallet distribution ────────────────────────────────────────
  deployerAddress: string | null;
  deployerMintBlock: string | null;   // bigint as string
  deployerMintAmount: string | null;  // bigint as string — original mint qty
  deployerCurrentBalance: string | null; // bigint as string — from holder scan
  deployerPct: number | null;         // % of total supply; null = unverified

  // Holder scan metadata
  holderScanFrom: string;    // bigint as string
  holderScanTo: string;      // bigint as string
  holderScanPartial: boolean; // true if some chunks failed
  holderScanFailed: boolean;  // true if ALL chunks failed
  top5Holders: Array<{ address: string; balance: string; pct: number }>;
  top5HoldersPct: number | null;

  // ── Liquidity ─────────────────────────────────────────────────────────────
  /** True only when a real, confirmed pool.liquidity() / StateView.getLiquidity()
   *  read came back > 0. False (not null) means "confirmed empty pool, this is
   *  a genuinely brand-new token" — distinct from the individual fields below
   *  being null due to an RPC failure. Every liquidity-dependent check
   *  (sell test, LP lock, pull history, wash trading, liquidity delta) is
   *  gated on this in scoring.ts rather than being scored as missing/risky. */
  hasLiquidity: boolean;
  poolLiquidity: string | null;      // bigint as string; null = read failed
  liquidityLocked: boolean | null;   // null = unknown
  initialLiquidityEth: number | null;

  // ── Liquidity delta monitoring ─────────────────────────────────────────────
  liquidityDeltaPct: number | null;       // % change since last snapshot
  liquidityPreviousReading: string | null; // previous liquidity value
  snapshotAgeMinutes: number | null;      // minutes since last snapshot

  // ── Sell-ability (honeypot) ─────────────────────────────────────────────
  sellTestPassed: boolean | null;      // null = couldn't run the test at all
  sellTestAmountSent: string | null;
  sellTestError: string | null;

  // ── LP position lock status ─────────────────────────────────────────────
  lpTokenId: string | null;
  lpPositionOwner: string | null;
  lpPositionStatus: "burned" | "locked_uncx" | "held_by_eoa" | "non_nft_position" | "unverified";

  // ── Liquidity pull history ──────────────────────────────────────────────
  liquidityEverPulled: boolean;
  burnEventCount: number;

  // ── Source verification ─────────────────────────────────────────────────
  sourceVerified: boolean | null;      // null = the Etherscan call itself failed
  suspiciousFunctions: {name: string, snippet: string}[];
  secondaryAdminDetected: boolean;
  secondaryAdminSnippet: string | null;
  /** "llm" | null (source unverified, no audit ran). No fallback method exists —
   *  a failed audit throws rather than ever producing a weaker-provenance result. */
  sourceAuditMethod: "llm" | null;
  /** Full rubric detail per function, including low-confidence/benign findings — for logging/debugging only. */
  sourceFunctionAudits: import("../agents/types.js").FunctionAudit[];
  /** True when isProxy=true AND the audit above ran against the real
   *  implementation contract's source rather than the thin proxy shim. */
  proxyImplementationAudited: boolean;
  /** Implementation address that was actually audited, when applicable. */
  proxyImplementationAddress: string | null;

  // ── Deployer history (in-process memory, resets on bot restart) ────────
  deployerSeenBefore: boolean;
  deployerPriorTokens: string[];

  // ── Deployer velocity (liquidity-independent) ────────────────────────────
  /** Number of direct contract-creation txs from the deployer in the 15 min
   *  before this token's deploy block. Factory-pattern deploys (via a launcher
   *  contract) are NOT counted — those require txlistinternal. */
  deploysLast15Min: number;
  deploysLastHour: number;
  deploysLast24h: number;
  /** On-chain-verified contract addresses deployed in the last 24 h window
   *  (from Etherscan txlist, to === "" txs). Used to augment bot-state history
   *  so a serial deployer is caught even the first time the bot sees them. */
  recentContracts: string[];

  // ── Deployer wallet age (liquidity-independent) ───────────────────────────
  /** Age of the deployer wallet in seconds at the moment this token was
   *  deployed (first-ever tx timestamp vs. deploy block timestamp).
   *  null = Etherscan call failed or ETHERSCAN_API_KEY not set. */
  walletAgeAtDeploySeconds: number | null;
  /** Seconds between the last inbound-value tx to the deployer wallet and the
   *  deploy block. A very short gap (<2 min) suggests the wallet was freshly
   *  funded specifically to deploy this token.
   *  null = could not determine (no prior incoming tx found, or API failure). */
  fundingGapSeconds: number | null;
  /** Address that sent the last inbound-value tx before the deploy, if found. */
  fundingSourceAddress: string | null;

  // ── Pre-liquidity distribution (liquidity-independent) ───────────────────
  /** Recipient addresses (excluding deployer, pool, null address) that received
   *  tokens via Transfer events between the mint block and the end of the
   *  holder scan window — i.e. before (or during) liquidity being added.
   *  These wallets were seeded before public trading was possible. */
  preSeededWallets: string[];
  /** Fraction of total supply currently held by preSeededWallets, 0–100.
   *  null = could not compute (holder scan failed or totalSupply = 0). */
  preSeededPct: number | null;

  // ── Trade activity (wash trading detection) ────────────────────────────
  totalSwaps: number;
  uniqueTraders: number;
  buyCount: number;
  sellCount: number;
  buySellRatio: number | null; // buyCount / sellCount, null if sellCount = 0
  roundTripTraderCount: number; // addresses that both bought AND sold
  roundTripTraderPct: number | null; // % of unique traders that round-tripped
  topTraderSwapSharePct: number; // e.g. 68% = one wallet did 68% of all swaps
  tradeScanPartial: boolean;

  // ── RPC warnings ──────────────────────────────────────────────────────────
  /** Every failed RPC call during collection. The LLM must treat any field
   *  that appears in this list as "unverified" rather than as a clean signal. */
  rpcWarnings: string[];
}


export interface TokenMeta {
  name:                 string;
  symbol:               string;
  decimals:             number;
  totalSupply:          bigint;
  totalSupplyFormatted: string;
}

export interface ReVerifyResult {
  /** Updated LP lock fields — only present when they changed from "unverified". */
  lpPositionStatus?: TokenEvidence["lpPositionStatus"];
  lpTokenId?: string | null;
  lpPositionOwner?: string | null;
  /** Updated pool liquidity — only present when the pool now has liquidity. */
  poolLiquidity?: string | null;
  liquidityLocked?: boolean | null;
  initialLiquidityEth?: number | null;
  /** True if any field improved vs the original snapshot. */
  improved: boolean;
  warnings: string[];
}

export interface HolderScanResult {
  balances: Map<string, bigint>;
  partial: boolean;   // some chunks failed but we have some data
  failed: boolean;    // all chunks failed, map is empty
  scanFrom: bigint;
  scanTo: bigint;
}

export interface V3PoolLog {
    venue: "v3";
    args: { token0: Address; token1: Address; fee: number; tickSpacing: number; pool: Address };
    blockNumber: bigint | null;
    transactionHash: `0x${string}` | null;
}

export interface V4PoolLog {
    venue: "v4";
    args: { id: `0x${string}`; currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address; sqrtPriceX96: bigint; tick: number };
    blockNumber: bigint | null;
    transactionHash: `0x${string}` | null;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCallResponse {
  type: "tool_calls";
  toolCalls: ToolCall[];
  raw: string;
}

export interface FinalResponse {
  type: "final";
  json: unknown;
  raw: string;
}

export interface DeployerResult {
  address: string | null;
  mintBlock: bigint | null;
  mintAmount: bigint | null;
  source: "tight" | "wide" | "unknown";
}

export interface TradeActivity {
  totalSwaps: number;
  uniqueTraders: number;
  buyCount: number;
  sellCount: number;
  buyerAddresses: Set<string>;
  sellerAddresses: Set<string>;
  roundTripTraders: string[];
  topTraderSwapShare: number; // % of total swaps done by the single busiest address
  scanPartial: boolean;
}

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

// Additional interfaces from other files
export interface HandlerSuccess {
  result: RugCheckResult;
  meta: TokenMeta;
}

export interface HandlerError {
  error: string;
}

export type HandlerOutcome = HandlerSuccess | HandlerError;


export interface RiskFlag {
  id: string;          // machine-readable key
  label: string;       // short human label
  detail: string;      // evidence sentence shown in the report
  severity: RiskLevel;
  points: number;      // used by rule engine; LLM sets 0 but field is required
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  output: unknown;
  ts: number;
  decision: IterationDecision;
}

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
  decisionTrace?: IterationDecision[];
}

export interface LLMScoreFailure {
  ok: false;
  reason: string;
  rawModelText?: string;
}

export type LLMScoreResult = LLMScoreSuccess | LLMScoreFailure;

export interface RugCheckResult {
  tokenAddress: Address;
  poolAddress: Address;
  pairedAsset: string;
  venue: Venue;
  /** V4 only: hook contract address from the Initialize event. null for V3 pools. */
  hookAddress: string | null;

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

  // ── Liquidity delta monitoring ──────────────────────────────────────────────
  liquidityDeltaPct: number | null;       // % change since last snapshot
  liquidityPreviousReading: string | null; // previous liquidity value
  snapshotAgeMinutes: number | null;      // minutes since last snapshot

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
  suspiciousFunctions: {name: string, snippet: string}[];
  secondaryAdminDetected: boolean;
  secondaryAdminSnippet: string | null;
  sourceAuditMethod?: "llm" | null;
  sourceFunctionAudits?: import("../agents/types.js").FunctionAudit[];
  deployerSeenBefore: boolean;
  deployerPriorTokens: string[];

  // ── Scoring ────────────────────────────────────────────────────────────────
  flags: RiskFlag[];
  /** 0 (safe) → 100 (certain rug), 2 decimal places. -1 means scoring failed
   *  (see verdict === "UNKNOWN") — never treat -1 as a real low-risk score. */
  score: number;
  verdict: VerdictLevel;
  summary: string;

  // ── Metadata ───────────────────────────────────────────────────────────────
  scoringMethod?: "rules" | "llm" | "llm-agentic" | "failed";
  scoringError?: string;             // set when LLM scoring fails
  /** Direct answer to the user's question, only present when asked via chat */
  answer?: string;
  /** Transcript of tool calls made during agentic scoring */
  toolCallTranscript?: ToolCallRecord[];
  /** Decision trace for stop/continue reasoning during agentic scoring */
  decisionTrace?: IterationDecision[];
  /** Analysis ID for retrieving full trace from Upstash */
  analysisId?: string;
}