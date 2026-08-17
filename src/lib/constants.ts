// ─── Chain ────────────────────────────────────────────────────────────────────

export const BASE_CHAIN_ID = 8453;

// ─── Contract addresses ───────────────────────────────────────────────────────

/** Uniswap V3 Factory on Base — source: https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments */
export const UNISWAP_V3_FACTORY =
  "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as const;

/** Well-known "quote asset" addresses on Base (all lowercase for easy comparison).
 *  A newly created pool almost always pairs the new token against one of these.
 */
export const KNOWN_QUOTE_ASSETS = new Set<string>([
  "0x4200000000000000000000000000000000000006", // WETH  (OP-Stack predeploy)
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC  (native)
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC (bridged USDC)
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI   (Base)
]);

/** Human-readable labels for known quote assets (used in log output) */
export const QUOTE_ASSET_LABELS: Record<string, string> = {
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

export const ETHERSCAN_API_BASE = "https://api.etherscan.io/v2/api";

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
] as const;
