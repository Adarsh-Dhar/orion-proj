/**
 * Main export file for the lib directory.
 * Re-exports commonly used interfaces, constants, and functions.
 */

// Re-export interfaces
export type {
  AgentLoopResult,
  ToolContext,
  StoredAnalysis,
  TokenMetadata,
  LiquiditySnapshot,
  WatchlistEntry,
  BotState,
  ComputedScore,
  TokenSummary,
  ScanResult,
  ScanOptions,
  TokenIdentity,
  ResolvedPool,
  TokenEvidence,
  TokenMeta,
  ReVerifyResult,
  HolderScanResult,
  V3PoolLog,
  V4PoolLog,
  ToolCall,
  ToolCallResponse,
  FinalResponse,
  DeployerResult,
  TradeActivity,
  MessagePart,
  Message,
  HandlerSuccess,
  HandlerError,
  HandlerOutcome,
} from "./utils/interface.js";

// Re-export types from rugcheck-types
export type {
  RiskFlag,
  ToolCallRecord,
  RugCheckResult,
  LLMScoreSuccess,
  LLMScoreFailure,
  LLMScoreResult,
} from "./rugcheck-types.js";

// Re-export constants and types
export {
  BASE_CHAIN_ID,
  UNISWAP_V3_FACTORY,
  UNISWAP_V4_POOL_MANAGER,
  UNISWAP_V4_STATE_VIEW,
  KNOWN_QUOTE_ASSETS,
  QUOTE_ASSET_LABELS,
  POOL_CREATED_ABI,
  V4_INITIALIZE_ABI,
  POOL_SLOT0_ABI,
  POOL_LIQUIDITY_ABI,
  POOL_TOKENS_ABI,
  V4_STATE_VIEW_SLOT0_ABI,
  V4_STATE_VIEW_LIQUIDITY_ABI,
  OWNER_ABI,
  EIP1967_IMPL_SLOT,
  NULL_ADDRESS,
  TRANSFER_EVENT_ABI,
  ERC20_ABI,
  UNISWAP_V3_POSITION_MANAGER,
  UNCX_V3_LOCKER,
  BURN_ADDRESS,
  UNISWAP_V4_UNIVERSAL_ROUTER,
  UNISWAP_V4_QUOTER,
  V4_QUOTER_EXACT_INPUT_SINGLE_ABI,
  ETHERSCAN_API_BASE,
  POOL_MINT_EVENT_ABI,
  POOL_BURN_EVENT_ABI,
  POOL_SWAP_EVENT_ABI,
  V4_SWAP_EVENT_ABI,
  V4_MODIFY_LIQUIDITY_EVENT_ABI,
  NPM_INCREASE_LIQUIDITY_EVENT_ABI,
  NPM_OWNER_OF_ABI,
  ERC20_TRANSFER_ABI,
  SUSPICIOUS_SOURCE_KEYWORDS,
  PRIVILEGE_KEYWORDS,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GEMINI_ENDPOINT,
} from "./utils/constants.js";

export type {
  Venue,
  RiskLevel,
  VerdictLevel,
  ScoreMode,
} from "./utils/constants.js";

// Re-export key functions from main modules
export { runRugCheckLLM, formatRugReport, formatAlertCard, formatChatReply } from "./rugcheck.js";
export { fetchTokenMetadata } from "./erc20.js";
export { resolveTokenPool, findContractDeployBlock, scanBlockRange, shortAddr, formatFee, identifyTokens } from "./scan-engine.js";
export { answerTokenQuestion, extractAddress, stripAddress } from "./rugcheck-handler.js";
export { loadState, saveState, alreadyPosted, markPosted, getDeployerHistory, recordDeployerToken, recordLiquiditySnapshot, addToWatchlist, getWatchlistTokens } from "./state.js";
export { sendReport, sendPlain, bot } from "./telegram.js";
export { collectEvidence, findDeployer, scanHolderBalances, checkLiquidityDelta, runSellTest, checkLpLockStatus, checkLiquidityPullHistory, scanTradeActivity, checkSourceVerification, reVerifyEvidence } from "./evidence.js";
export { computeScore, attachComputedScore } from "./scoring.js";
export { storeAnalysis, getAnalysis, getLatestAnalysis, getAllAnalysisIds, getMultipleAnalyses, updateAnalysis } from "./analysis-store.js";
export { runAgentLoop } from "./agents/agent-loop.js";
export { AGENT_TOOLS, dispatchTool } from "./agents/agent-tools.js";
export { initQuoteAssets, isKnownQuoteAsset, getQuoteAssetLabel } from "./quote-assets.js";