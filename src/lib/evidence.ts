/**
 * evidence.ts — pure on-chain data collection, no scoring.
 *
 * Exports:
 *   collectEvidence(client, tokenAddress, poolAddress, pairedAsset, deployBlock)
 *     → TokenEvidence
 *
 * All RPC failures are logged to stdout AND recorded in `rpcWarnings[]` so
 * the LLM scorer can see which fields are unverified rather than treating
 * nulls as implicitly clean.
 *
 * Key fix vs old rugcheck.ts:
 *   getHolderBalances now resolves "latest" explicitly via getBlockNumber(),
 *   then walks FORWARD in SCAN_CHUNK (10k-block) windows rather than making
 *   one unbounded call. This eliminates the "range exceeds limit" error that
 *   broke every historical scan.
 */

import { type Address, formatEther } from "viem";
import type { PublicClient } from "viem";
import {
  OWNER_ABI,
  NULL_ADDRESS,
  EIP1967_IMPL_SLOT,
  POOL_SLOT0_ABI,
  POOL_LIQUIDITY_ABI,
  TRANSFER_EVENT_ABI,
  ERC20_ABI,
} from "./constants.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

const SCAN_CHUNK   = 10_000n;
const MAX_LOOKBACK = 200_000n;
const ZERO_SLOT    =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// ─── TokenEvidence ────────────────────────────────────────────────────────────

/**
 * All numbers that could overflow JSON's float precision are stored as
 * strings. The LLM receives this object serialised as JSON so bigint →
 * string conversion is done here, not in the scorer.
 */
export interface TokenEvidence {
  // ── Identity ──────────────────────────────────────────────────────────────
  tokenAddress: string;
  poolAddress: string;
  pairedAsset: string;
  deployBlock: string;   // bigint as string

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
  poolLiquidity: string | null;      // bigint as string; null = read failed
  liquidityLocked: boolean | null;   // null = unknown
  initialLiquidityEth: number | null;

  // ── RPC warnings ──────────────────────────────────────────────────────────
  /** Every failed RPC call during collection. The LLM must treat any field
   *  that appears in this list as "unverified" rather than as a clean signal. */
  rpcWarnings: string[];
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function warn(warnings: string[], tag: string, context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
  const entry = `[${tag}] ${context}: ${msg}`;
  console.warn(`  [evidence:${tag}] ${context}: ${msg}`);
  warnings.push(entry);
}

async function safeRead<T>(
  fn: () => Promise<T>,
  fallback: T,
  tag: string,
  warnings: string[]
): Promise<T> {
  try { return await fn(); }
  catch (err) { warn(warnings, tag, "read failed, using fallback", err); return fallback; }
}

async function safeReadNullable<T>(
  fn: () => Promise<T>,
  tag: string,
  warnings: string[]
): Promise<T | null> {
  try { return await fn(); }
  catch (err) { warn(warnings, tag, "read failed", err); return null; }
}

// ─── Deployer finder ─────────────────────────────────────────────────────────

interface DeployerResult {
  address: string | null;
  mintBlock: bigint | null;
  mintAmount: bigint | null;
  source: "tight" | "wide" | "unknown";
}

async function findDeployer(
  client: AnyClient,
  tokenAddress: Address,
  deployBlock: bigint,
  warnings: string[]
): Promise<DeployerResult> {
  const MINT_LOOKBACK = 500n;
  const tightFrom = deployBlock > MINT_LOOKBACK ? deployBlock - MINT_LOOKBACK : 0n;

  // Pass 1 — tight window around pool creation
  try {
    const logs = await client.getLogs({
      address: tokenAddress,
      event: TRANSFER_EVENT_ABI[0],
      args: { from: NULL_ADDRESS as Address },
      fromBlock: tightFrom,
      toBlock: deployBlock,
    });
    if (logs.length > 0) {
      const sorted = [...logs].sort((a, b) => (a.blockNumber! < b.blockNumber! ? -1 : 1));
      const first  = sorted[0];
      const to     = (first.args as { to: string }).to ?? null;
      const value  = (first.args as { value?: bigint }).value ?? null;
      return { address: to, mintBlock: first.blockNumber ?? null, mintAmount: value, source: "tight" };
    }
  } catch (err) {
    warn(warnings, "findDeployer", `tight-window [${tightFrom}, ${deployBlock}] failed`, err);
  }

  // Pass 2 — walk backwards in 10k-block chunks up to 200k blocks
  const hardFloor = deployBlock > MAX_LOOKBACK ? deployBlock - MAX_LOOKBACK : 0n;
  let chunkEnd = tightFrom > 1n ? tightFrom - 1n : 0n;

  while (chunkEnd > hardFloor) {
    const chunkStart = chunkEnd > SCAN_CHUNK ? chunkEnd - SCAN_CHUNK : 0n;
    try {
      const logs = await client.getLogs({
        address: tokenAddress,
        event: TRANSFER_EVENT_ABI[0],
        args: { from: NULL_ADDRESS as Address },
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });
      if (logs.length > 0) {
        const sorted = [...logs].sort((a, b) => (a.blockNumber! < b.blockNumber! ? -1 : 1));
        const first  = sorted[0];
        const to     = (first.args as { to: string }).to ?? null;
        const value  = (first.args as { value?: bigint }).value ?? null;
        return { address: to, mintBlock: first.blockNumber ?? null, mintAmount: value, source: "wide" };
      }
    } catch (err) {
      warn(warnings, "findDeployer", `wide chunk [${chunkStart}, ${chunkEnd}] failed`, err);
    }
    if (chunkStart === 0n) break;
    chunkEnd = chunkStart - 1n;
  }

  return { address: null, mintBlock: null, mintAmount: null, source: "unknown" };
}

// ─── Holder balance scan ──────────────────────────────────────────────────────

interface HolderScanResult {
  balances: Map<string, bigint>;
  partial: boolean;   // some chunks failed but we have some data
  failed: boolean;    // all chunks failed, map is empty
  scanFrom: bigint;
  scanTo: bigint;
}

/**
 * Fetch holder balances by scanning Transfer events from `fromBlock` to the
 * current chain head, walking forward in SCAN_CHUNK (10k) windows.
 *
 * This replaces the old single getLogs({ toBlock: "latest" }) call which
 * always failed with "range exceeds limit" on any scan more than 10k blocks
 * from the current head — which is true of all historical tokens.
 */
async function scanHolderBalances(
  client: AnyClient,
  tokenAddress: Address,
  fromBlock: bigint,
  warnings: string[]
): Promise<HolderScanResult> {
  const latestBlock = await client.getBlockNumber();
  const balances    = new Map<string, bigint>();
  let chunksFailed  = 0;
  let chunksTotal   = 0;

  for (let chunkStart = fromBlock; chunkStart <= latestBlock; chunkStart += SCAN_CHUNK) {
    const chunkEnd = chunkStart + SCAN_CHUNK - 1n < latestBlock
      ? chunkStart + SCAN_CHUNK - 1n
      : latestBlock;

    chunksTotal++;
    try {
      const logs = await client.getLogs({
        address: tokenAddress,
        event: TRANSFER_EVENT_ABI[0],
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });
      for (const log of logs) {
        const args = log.args as { from: string; to: string; value: bigint };
        const { from, to, value } = args;
        if (!value) continue;
        if (from !== NULL_ADDRESS) {
          balances.set(from, (balances.get(from) ?? 0n) - value);
        }
        balances.set(to, (balances.get(to) ?? 0n) + value);
      }
    } catch (err) {
      chunksFailed++;
      warn(warnings, "holderScan", `chunk [${chunkStart}, ${chunkEnd}] failed`, err);
    }
  }

  // Remove dust / burned balances
  for (const [addr, bal] of balances) {
    if (bal <= 0n) balances.delete(addr);
  }

  return {
    balances,
    partial: chunksFailed > 0 && chunksFailed < chunksTotal,
    failed:  chunksFailed === chunksTotal && chunksTotal > 0,
    scanFrom: fromBlock,
    scanTo:   latestBlock,
  };
}

// ─── Main collection function ─────────────────────────────────────────────────

export async function collectEvidence(
  client: AnyClient,
  tokenAddress: Address,
  poolAddress: Address,
  pairedAsset: string,
  deployBlock: bigint,
  /** pre-fetched ERC-20 metadata (avoids a second round of reads) */
  meta: { name: string; symbol: string; decimals: number; totalSupply: bigint; totalSupplyFormatted: string }
): Promise<TokenEvidence> {
  const warnings: string[] = [];

  // ── 1. ERC-20 supply / decimals (already in meta, just surface them) ──────
  const { name, symbol, decimals, totalSupply, totalSupplyFormatted } = meta;

  // ── 2. Ownership ───────────────────────────────────────────────────────────
  let ownerAddress: string | null = null;
  let ownershipRenounced: boolean | null = null;
  try {
    ownerAddress = await client.readContract({
      address: tokenAddress,
      abi: OWNER_ABI,
      functionName: "owner",
    }) as string;
    ownershipRenounced = ownerAddress === NULL_ADDRESS;
  } catch (err) {
    warn(warnings, "owner", "owner() call failed", err);
  }

  // ── 3. Proxy check ─────────────────────────────────────────────────────────
  let isProxy: boolean | null = null;
  try {
    const slot = await client.getStorageAt({ address: tokenAddress, slot: EIP1967_IMPL_SLOT });
    isProxy = slot !== undefined ? slot !== ZERO_SLOT : null;
  } catch (err) {
    warn(warnings, "proxy", "EIP-1967 slot read failed", err);
  }

  // ── 4. Deployer (mint event scan) ─────────────────────────────────────────
  const deployer = await findDeployer(client, tokenAddress, deployBlock, warnings);

  // ── 5. Holder balances ─────────────────────────────────────────────────────
  // Anchor the holder scan from the mint block if we found it (most accurate),
  // otherwise from deployBlock - 10k (conservative fallback).
  const holderScanFrom = deployer.mintBlock !== null
    ? deployer.mintBlock
    : deployBlock > 10_000n ? deployBlock - 10_000n : 0n;

  const holderScan = await scanHolderBalances(client, tokenAddress, holderScanFrom, warnings);

  // Deployer's current balance from the holder scan
  let deployerCurrentBalance: bigint | null = null;
  if (!holderScan.failed && deployer.address) {
    deployerCurrentBalance = holderScan.balances.get(deployer.address.toLowerCase()) ?? 0n;
  }

  // If we found the deployer via wide scan and their mint predates the holder
  // scan window, the current balance will be 0 (transfer not in range) —
  // fall back to mint amount as a floor estimate and record it.
  if (
    deployer.source === "wide" &&
    deployer.mintBlock !== null &&
    deployer.mintBlock < holderScanFrom &&
    deployerCurrentBalance === 0n &&
    deployer.mintAmount !== null
  ) {
    deployerCurrentBalance = deployer.mintAmount;
    warnings.push(
      "[holderScan] deployer balance is a floor estimate — mint predates scan window"
    );
  }

  const deployerPct: number | null =
    deployer.address && totalSupply > 0n && deployerCurrentBalance !== null
      ? Number((deployerCurrentBalance * 10_000n) / totalSupply) / 100
      : null;

  // Top-5 holders (excluding the pool address itself)
  const sortedHolders = [...holderScan.balances.entries()]
    .filter(([addr]) => addr.toLowerCase() !== poolAddress.toLowerCase())
    .sort((a, b) => (b[1] > a[1] ? 1 : -1));

  const top5 = sortedHolders.slice(0, 5).map(([address, balance]) => ({
    address,
    balance: balance.toString(),
    pct: totalSupply > 0n ? Number((balance * 10_000n) / totalSupply) / 100 : 0,
  }));

  const top5Balance = sortedHolders
    .slice(0, 5)
    .reduce((acc, [, bal]) => acc + bal, 0n);

  const top5HoldersPct: number | null = holderScan.failed
    ? null
    : totalSupply > 0n ? Number((top5Balance * 10_000n) / totalSupply) / 100 : 0;

  // ── 6. Pool liquidity ──────────────────────────────────────────────────────
  const poolLiquidityRaw = await safeReadNullable<bigint>(
    () => client.readContract({ address: poolAddress, abi: POOL_LIQUIDITY_ABI, functionName: "liquidity" }) as Promise<bigint>,
    "pool.liquidity",
    warnings
  );
  const liquidityLocked = poolLiquidityRaw === null ? null : poolLiquidityRaw > 0n;

  let initialLiquidityEth: number | null = null;
  if (poolLiquidityRaw !== null && poolLiquidityRaw > 0n) {
    try {
      const slot0 = await client.readContract({
        address: poolAddress,
        abi: POOL_SLOT0_ABI,
        functionName: "slot0",
      }) as readonly [bigint, ...unknown[]];
      const sqrtPriceX96 = slot0[0];
      if (sqrtPriceX96 > 0n) {
        const Q96 = 2n ** 96n;
        const raw = Number(formatEther((poolLiquidityRaw * Q96) / sqrtPriceX96));

        // Sanity bound: total ETH ever in existence is ~120M.
        // Values above this are a sqrtPriceX96 math artifact (near-zero price
        // → near-zero divisor → astronomically large quotient). Treat as invalid.
        const ETH_SUPPLY_MAX = 200_000_000; // 200M — generous headroom
        if (raw > ETH_SUPPLY_MAX) {
          warnings.push(
            `[pool.slot0] initialLiquidityEth computation yielded ${raw.toFixed(0)} ETH — ` +
            `physically impossible (total ETH supply ~120M). Likely a near-zero sqrtPriceX96 ` +
            `artifact. Value nulled; treat pool liquidity as unverified.`
          );
          initialLiquidityEth = null;
        } else {
          initialLiquidityEth = raw;
        }
      }
    } catch (err) {
      warn(warnings, "pool.slot0", "slot0 read failed", err);
    }
  }

  // ── 7. Assemble ────────────────────────────────────────────────────────────
  return {
    tokenAddress,
    poolAddress,
    pairedAsset,
    deployBlock: deployBlock.toString(),

    name,
    symbol,
    decimals,
    totalSupply: totalSupply.toString(),
    totalSupplyFormatted,

    ownerAddress,
    ownershipRenounced,
    isProxy,

    deployerAddress:        deployer.address,
    deployerMintBlock:      deployer.mintBlock?.toString() ?? null,
    deployerMintAmount:     deployer.mintAmount?.toString() ?? null,
    deployerCurrentBalance: deployerCurrentBalance?.toString() ?? null,
    deployerPct,

    holderScanFrom:    holderScan.scanFrom.toString(),
    holderScanTo:      holderScan.scanTo.toString(),
    holderScanPartial: holderScan.partial,
    holderScanFailed:  holderScan.failed,
    top5Holders:       top5,
    top5HoldersPct,

    poolLiquidity:       poolLiquidityRaw?.toString() ?? null,
    liquidityLocked,
    initialLiquidityEth,

    rpcWarnings: warnings,
  };
}
