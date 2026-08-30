/**
 * agents/tools.ts — tool schemas and dispatchers for the specialist agents.
 *
 * REPLACES the old monolithic agent-tools.ts (one 7-tool list + one switch
 * dispatcher shared by a single agent loop). Now that each specialist owns
 * exactly the tool(s) its domain needs, the schemas and dispatch logic are
 * grouped the same way: one export pair per specialist.
 */

import type { Address, PublicClient } from "viem";
import type { ToolContext } from "../utils/interface.js";
import {
  scanHolderBalances,
  checkSourceVerification,
  runSellTest as runSellTestEvidence,
  checkLpLockStatus,
  scanTradeActivity,
  checkDeployerVelocity,
} from "../evidence.js";
import { getDeployerHistory } from "../state.js";
import { POOL_TOKENS_ABI, ERC20_ABI } from "../utils/constants.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

export type { ToolContext };

// ─── source-owner-agent: getSourceCode ──────────────────────────────────────

export const SOURCE_OWNER_TOOLS = [
  {
    name: "getSourceCode",
    tier: 1,
    description:
      "Fetch verified source code from Etherscan and flag suspicious functions and secondary-admin patterns. Returns source verification status and any suspicious function snippets.",
    parameters: {
      type: "object",
      properties: {
        tokenAddress: { type: "string", description: "The token contract address" },
        ownershipRenounced: { type: "boolean", description: "Whether ownership is renounced" },
        ownerAddress: { type: "string", description: "The current owner address" },
      },
      required: ["tokenAddress", "ownershipRenounced", "ownerAddress"],
    },
  },
] as const;

export async function dispatchSourceOwnerTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  const warnings: string[] = [];
  switch (name) {
    case "getSourceCode": {
      const result = await checkSourceVerification(
        ctx.client as AnyClient,
        ctx.tokenAddress,
        warnings,
        args.ownershipRenounced as boolean | null,
        args.ownerAddress as string | null,
        ctx.isProxy
      );
      return { ...result, warnings };
    }
    default:
      throw new Error(`Unknown tool for source-owner-agent: ${name}`);
  }
}

// ─── deployer-reputation-agent: getDeployerHistory + getDeployerVelocity ────

export const DEPLOYER_REPUTATION_TOOLS = [
  {
    name: "getDeployerHistory",
    tier: 3,
    description:
      "Check if this deployer address has launched tokens before. Returns list of prior token addresses from persistent state.",
    parameters: {
      type: "object",
      properties: {
        deployerAddress: { type: "string", description: "The deployer address to check" },
      },
      required: ["deployerAddress"],
    },
  },
  {
    name: "getDeployerVelocity",
    tier: 3,
    description:
      "Check how many contracts this deployer created in the 15min/1h/24h window before deploy.",
    parameters: {
      type: "object",
      properties: {
        deployerAddress: { type: "string" },
        deployBlockTimestamp: { type: "number" },
      },
      required: ["deployerAddress", "deployBlockTimestamp"],
    },
  },
] as const;

export async function dispatchDeployerReputationTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  const warnings: string[] = [];
  switch (name) {
    case "getDeployerHistory": {
      if (!ctx.state) {
        return {
          deployerSeenBefore: false,
          deployerPriorTokens: [],
          warnings: ["No state available for deployer history"],
        };
      }
      const priorTokens = getDeployerHistory(ctx.state, args.deployerAddress as string);
      return {
        deployerSeenBefore: priorTokens.length > 0,
        deployerPriorTokens: priorTokens,
        warnings,
      };
    }
    case "getDeployerVelocity": {
      const etherscanApiKey = process.env.ETHERSCAN_API_KEY;
      if (!etherscanApiKey) {
        return {
          deploysLast15Min: 0,
          deploysLastHour: 0,
          deploysLast24h: 0,
          recentContracts: [],
          warnings: ["ETHERSCAN_API_KEY not set"],
        };
      }
      const result = await checkDeployerVelocity(
        args.deployerAddress as string,
        args.deployBlockTimestamp as number,
        etherscanApiKey,
        warnings
      );
      return { ...result, warnings };
    }
    default:
      throw new Error(`Unknown tool for deployer-reputation-agent: ${name}`);
  }
}

// ─── holder-distribution-agent: getHolderLedger ─────────────────────────────

export const HOLDER_DISTRIBUTION_TOOLS = [
  {
    name: "getHolderLedger",
    tier: 4,
    description:
      "Fetch top holder balances and % of supply for the token. Returns a map of addresses to balances and percentage breakdown.",
    parameters: {
      type: "object",
      properties: {
        tokenAddress: { type: "string", description: "The token contract address" },
        poolAddress: { type: "string", description: "The pool address to exclude from holder analysis" },
      },
      required: ["tokenAddress", "poolAddress"],
    },
  },
] as const;

export async function dispatchHolderDistributionTool(
  name: string,
  _args: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  switch (name) {
    case "getHolderLedger": {
      const warnings: string[] = [];
      const fromBlock = ctx.deployBlock > 10_000n ? ctx.deployBlock - 10_000n : 0n;
      const result = await scanHolderBalances(ctx.client as AnyClient, ctx.tokenAddress, fromBlock, warnings);

      const totalSupply = (await (ctx.client as AnyClient).readContract({
        address: ctx.tokenAddress,
        abi: ERC20_ABI,
        functionName: "totalSupply",
      })) as bigint;

      const holders: Array<{ address: string; balance: string; pct: number }> = [];
      for (const [addr, bal] of result.balances.entries()) {
        if (addr.toLowerCase() !== ctx.poolAddress.toLowerCase() && bal > 0n) {
          holders.push({
            address: addr,
            balance: bal.toString(),
            pct: totalSupply > 0n ? Number((bal * 10_000n) / totalSupply) / 100 : 0,
          });
        }
      }
      holders.sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));

      return {
        topHolders: holders.slice(0, 10),
        scanPartial: result.partial,
        scanFailed: result.failed,
        warnings,
      };
    }
    default:
      throw new Error(`Unknown tool for holder-distribution-agent: ${name}`);
  }
}

// ─── lp-honeypot-agent: checkLpLock + runSellTest ───────────────────────────

export const LP_HONEYPOT_TOOLS = [
  {
    name: "checkLpLock",
    tier: 2,
    description:
      "Check whether the LP position is burned, locked, or held by an EOA. Returns the LP token ID, position owner, and lock status.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "runSellTest",
    tier: 6,
    description:
      "Simulate a sell from a given holder at a given % of their balance to test for honeypot behavior. Returns whether the sell would succeed.",
    parameters: {
      type: "object",
      properties: {
        holderAddress: { type: "string", description: "The holder address to test" },
        amountPct: {
          type: "number",
          description: "Percentage of holder's balance to sell (e.g., 5 for 5%, 50 for 50%)",
        },
      },
      required: ["holderAddress", "amountPct"],
    },
  },
] as const;

export async function dispatchLpHoneypotTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  const warnings: string[] = [];
  switch (name) {
    case "checkLpLock": {
      const result = await checkLpLockStatus(ctx.client as AnyClient, ctx.poolAddress, ctx.deployBlock, warnings);
      return { ...result, warnings };
    }
    case "runSellTest": {
      const result = await runSellTestEvidence(
        ctx.client as AnyClient,
        ctx.tokenAddress,
        ctx.poolAddress,
        args.holderAddress as Address,
        args.amountPct as number,
        warnings
      );
      return { ...result, warnings };
    }
    default:
      throw new Error(`Unknown tool for lp-honeypot-agent: ${name}`);
  }
}

// ─── trading-activity-agent: getTradeHistory ────────────────────────────────

export const TRADING_ACTIVITY_TOOLS = [
  {
    name: "getTradeHistory",
    tier: 5,
    description:
      "Scan swap events for wash-trading / bot-volume patterns. Returns total swaps, unique traders, buy/sell counts, and round-trip analysis.",
    parameters: { type: "object", properties: {}, required: [] },
  },
] as const;

export async function dispatchTradingActivityTool(
  name: string,
  _args: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  switch (name) {
    case "getTradeHistory": {
      const warnings: string[] = [];
      let token0IsTarget = false;
      try {
        const token0 = (await (ctx.client as AnyClient).readContract({
          address: ctx.poolAddress,
          abi: POOL_TOKENS_ABI,
          functionName: "token0",
        })) as string;
        token0IsTarget = token0.toLowerCase() === ctx.tokenAddress.toLowerCase();
      } catch (err) {
        warnings.push(`Failed to read pool token0/token1: ${err instanceof Error ? err.message : String(err)}`);
      }

      const result = await scanTradeActivity(
        ctx.client as AnyClient,
        ctx.poolAddress,
        ctx.deployBlock,
        token0IsTarget,
        warnings
      );

      const buySellRatio = result.sellCount > 0 ? result.buyCount / result.sellCount : null;
      const roundTripTraderPct =
        result.uniqueTraders > 0 ? (result.roundTripTraders.length / result.uniqueTraders) * 100 : null;

      return {
        totalSwaps: result.totalSwaps,
        uniqueTraders: result.uniqueTraders,
        buyCount: result.buyCount,
        sellCount: result.sellCount,
        buySellRatio,
        roundTripTraderCount: result.roundTripTraders.length,
        roundTripTraderPct,
        topTraderSwapShare: result.topTraderSwapShare,
        scanPartial: result.scanPartial,
        warnings,
      };
    }
    default:
      throw new Error(`Unknown tool for trading-activity-agent: ${name}`);
  }
}
