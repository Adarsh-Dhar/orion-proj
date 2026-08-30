export const BASE_CHAIN_ID = 8453;

// Import types from rugcheck-types to avoid circular dependencies
export type { Venue, RiskLevel, VerdictLevel } from "../rugcheck-types.js";

/** Uniswap V3 Factory on Base — source: https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments */
export const UNISWAP_V3_FACTORY =
  "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as const;

/** Uniswap V4 PoolManager on Base — source: https://docs.uniswap.org/contracts/v4/deployments */
export const UNISWAP_V4_POOL_MANAGER =
  "0x498581fF718922c3f8e6A244956aF099B2652b2b" as const;

/** Uniswap V4 StateView on Base — used for reading pool state */
export const UNISWAP_V4_STATE_VIEW =
  "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71" as const;

/** Well-known "quote asset" addresses on Base (all lowercase for easy comparison).
 *  A newly created pool almost always pairs the new token against one of these.
 *  Note: V4 uses address(0) for native ETH instead of WETH.
 *
 * @deprecated Use `isKnownQuoteAsset()` from `./quote-assets.js` instead.
 *  This set is kept for backward-compatibility with any external consumers
 *  but is no longer used by scan-engine.ts.
 */
export const KNOWN_QUOTE_ASSETS = new Set<string>([
  "0x0000000000000000000000000000000000000000", // ETH   (native, V4 only)
  "0x4200000000000000000000000000000000000006", // WETH  (OP-Stack predeploy)
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC  (native)
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC (bridged USDC)
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI   (Base)
]);

/** Human-readable labels for known quote assets (used in log output)
 *
 * @deprecated Use `getQuoteAssetLabel()` from `./quote-assets.js` instead.
 *  This record is kept for backward-compatibility with any external consumers
 *  but is no longer used by scan-engine.ts.
 */
export const QUOTE_ASSET_LABELS: Record<string, string> = {
  "0x0000000000000000000000000000000000000000": "ETH",
  "0x4200000000000000000000000000000000000006": "WETH",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": "USDbC",
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": "DAI",
};

// ─── ABIs (minimal — only the fragments we actually use) ──────────────────────

/** Single-event ABI fragment for Uniswap V3 PoolCreated */
export const POOL_CREATED_ABI = [
  {
    type: "event",
    name: "PoolCreated",
    inputs: [
      { name: "token0", type: "address", indexed: true },
      { name: "token1", type: "address", indexed: true },
      { name: "fee", type: "uint24", indexed: true },
      { name: "tickSpacing", type: "int24", indexed: false },
      { name: "pool", type: "address", indexed: false },
    ],
  },
] as const;

/** Single-event ABI fragment for Uniswap V4 Initialize */
export const V4_INITIALIZE_ABI = [
  {
    type: "event",
    name: "Initialize",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "currency0", type: "address", indexed: true },
      { name: "currency1", type: "address", indexed: true },
      { name: "fee", type: "uint24", indexed: false },
      { name: "tickSpacing", type: "int24", indexed: false },
      { name: "hooks", type: "address", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "tick", type: "int24", indexed: false },
    ],
  },
] as const;

// ─── Uniswap V3 Pool ABI (minimal) ───────────────────────────────────────────

/** slot0: current price + tick info */
export const POOL_SLOT0_ABI = [
  {
    type: "function",
    name: "slot0",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
    stateMutability: "view",
  },
] as const;

/** liquidity: total in-range liquidity */
export const POOL_LIQUIDITY_ABI = [
  {
    type: "function",
    name: "liquidity",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
    stateMutability: "view",
  },
] as const;

/** token0 / token1 getters on a V3 pool */
export const POOL_TOKENS_ABI = [
  {
    type: "function",
    name: "token0",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "token1",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

/** V4 StateView.getSlot0 ABI */
export const V4_STATE_VIEW_SLOT0_ABI = [
  {
    type: "function",
    name: "getSlot0",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint16" },
      { name: "lpFee", type: "uint24" },
    ],
    stateMutability: "view",
  },
] as const;

/** V4 StateView.getLiquidity ABI */
export const V4_STATE_VIEW_LIQUIDITY_ABI = [
  {
    type: "function",
    name: "getLiquidity",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint128" }],
    stateMutability: "view",
  },
] as const;

// ─── Ownership ABI fragments ──────────────────────────────────────────────────

/** Ownable: owner() — present on most OpenZeppelin-based tokens */
export const OWNER_ABI = [
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

/** EIP-1967 transparent proxy implementation slot */
export const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

/** null address — returned by owner() when ownership is renounced */
export const NULL_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// ─── Transfer event ABI (for dev wallet analysis) ────────────────────────────

export const TRANSFER_EVENT_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Minimal ERC-20 ABI — only the four metadata reads we need */
export const ERC20_ABI = [
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalSupply",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ── New: LP / honeypot / source-check constants ────────────────────────────

export const UNISWAP_V3_POSITION_MANAGER =
  "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1" as const;
export const UNCX_V3_LOCKER =
  "0x231278eDd38B00B07fBd52120CEf685B9BaEBCC1" as const;
export const BURN_ADDRESS =
  "0x000000000000000000000000000000000000dEaD" as const;

/**
 * Uniswap V4 Universal Router on Base.
 * Used for simulating V4 swaps in the sell-ability test.
 * Source: https://docs.uniswap.org/contracts/v4/deployments
 */
export const UNISWAP_V4_UNIVERSAL_ROUTER =
  "0x6fF5693b99212Da76ad316178A184AB56D299b43" as const;

/**
 * Uniswap V4 Quoter on Base.
 * Used for quoting V4 swaps without executing them.
 * Source: https://docs.uniswap.org/contracts/v4/deployments
 */
export const UNISWAP_V4_QUOTER =
  "0x0d5e0F971ED27FBfF6c2837bf31316121532048D" as const;

/**
 * V4 Quoter.quoteExactInputSingle ABI — simulates a single-hop V4 swap and
 * returns the output amount.  We use this for the sell-ability test on V4
 * tokens: if the call reverts, the pool has a hook that blocks sells.
 */
export const V4_QUOTER_EXACT_INPUT_SINGLE_ABI = [{
  type: "function",
  name: "quoteExactInputSingle",
  stateMutability: "nonpayable",
  inputs: [
    {
      name: "params",
      type: "tuple",
      components: [
        { name: "poolKey", type: "tuple", components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ]},
        { name: "zeroForOne", type: "bool" },
        { name: "exactAmount", type: "uint128" },
        { name: "hookData", type: "bytes" },
      ],
    },
  ],
  outputs: [
    { name: "amountOut", type: "uint256" },
    { name: "gasEstimate", type: "uint256" },
  ],
}] as const;

export const ETHERSCAN_API_BASE = "https://api.etherscan.io/v2/api";

/** keccak256("Transfer(address,address,uint256)") — topic0 for every ERC-20
 *  Transfer log. Used to query Etherscan's log-indexing API directly instead
 *  of raw eth_getLogs, which is subject to RPC-provider block-range caps
 *  (e.g. Alchemy free tier: 10 blocks on Base). */
export const ERC20_TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

export const POOL_MINT_EVENT_ABI = [{
  type: "event",
  name: "Mint",
  inputs: [
    { name: "sender", type: "address", indexed: false },
    { name: "owner", type: "address", indexed: true },
    { name: "tickLower", type: "int24", indexed: true },
    { name: "tickUpper", type: "int24", indexed: true },
    { name: "amount", type: "uint128", indexed: false },
    { name: "amount0", type: "uint256", indexed: false },
    { name: "amount1", type: "uint256", indexed: false },
  ],
}] as const;

export const POOL_BURN_EVENT_ABI = [{
  type: "event",
  name: "Burn",
  inputs: [
    { name: "owner", type: "address", indexed: true },
    { name: "tickLower", type: "int24", indexed: true },
    { name: "tickUpper", type: "int24", indexed: true },
    { name: "amount", type: "uint128", indexed: false },
    { name: "amount0", type: "uint256", indexed: false },
    { name: "amount1", type: "uint256", indexed: false },
  ],
}] as const;

export const POOL_SWAP_EVENT_ABI = [{
  type: "event",
  name: "Swap",
  inputs: [
    { name: "sender", type: "address", indexed: true },
    { name: "recipient", type: "address", indexed: true },
    { name: "amount0", type: "int256", indexed: false },
    { name: "amount1", type: "int256", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "liquidity", type: "uint128", indexed: false },
    { name: "tick", type: "int24", indexed: false },
  ],
}] as const;

/** V4 Swap event ABI (emitted on PoolManager, filtered by PoolId) */
export const V4_SWAP_EVENT_ABI = [{
  type: "event",
  name: "Swap",
  inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "recipient", type: "address", indexed: true },
    { name: "amount0", type: "int256", indexed: false },
    { name: "amount1", type: "int256", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "liquidity", type: "uint128", indexed: false },
    { name: "tick", type: "int24", indexed: false },
  ],
}] as const;

/** V4 ModifyLiquidity event ABI (emitted on PoolManager, filtered by PoolId) */
export const V4_MODIFY_LIQUIDITY_EVENT_ABI = [{
  type: "event",
  name: "ModifyLiquidity",
  inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "tickLower", type: "int24", indexed: true },
    { name: "tickUpper", type: "int24", indexed: true },
    { name: "liquidityDelta", type: "int128", indexed: false },
    { name: "amount0", type: "uint256", indexed: false },
    { name: "amount1", type: "uint256", indexed: false },
  ],
}] as const;

export const NPM_INCREASE_LIQUIDITY_EVENT_ABI = [{
  type: "event",
  name: "IncreaseLiquidity",
  inputs: [
    { name: "tokenId", type: "uint256", indexed: true },
    { name: "liquidity", type: "uint128", indexed: false },
    { name: "amount0", type: "uint256", indexed: false },
    { name: "amount1", type: "uint256", indexed: false },
  ],
}] as const;

export const NPM_OWNER_OF_ABI = [{
  type: "function",
  name: "ownerOf",
  stateMutability: "view",
  inputs: [{ name: "tokenId", type: "uint256" }],
  outputs: [{ name: "", type: "address" }],
}] as const;

export const ERC20_TRANSFER_ABI = [{
  type: "function",
  name: "transfer",
  stateMutability: "nonpayable",
  inputs: [
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [{ name: "", type: "bool" }],
}] as const;

export const SUSPICIOUS_SOURCE_KEYWORDS = [
  "blacklist", "_isBlacklisted", "isBlacklisted",
  "setFee", "setTax", "excludeFromFee",
  "pause(", "disableTrading", "enableTrading",
  "mint(", "_maxTxAmount", "cooldown", "sniperProtection", "feeExempt", "_reflectionFee",
] as const;

export const PRIVILEGE_KEYWORDS = [
  "onlyOwner", "onlyAdmin", "onlyManager", "hasRole", "AccessControl", "modifier only",
] as const;

export type ScoreMode = "alert" | "chat" | "agentic";

// Gemini API configuration
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash-lite";
export const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;