/**
 * agent-tools.ts — tool schemas and dispatcher for the agentic LLM loop.
 *
 * Defines the function calling interface that Gemini can use to request
 * additional evidence collection, and dispatches those calls to the
 * appropriate evidence.ts functions.
 */

import type { Address } from "viem";
import type { PublicClient } from "viem";
import type { BotState } from "../state.js";
import type { IterationDecision } from "../utils/interface.js";
import {
  scanHolderBalances,
  checkSourceVerification,
  runSellTest,
  checkLpLockStatus,
  findDeployer,
  scanTradeActivity,
  checkDeployerVelocity,
  // wallet-age + pre-seed helpers — currently only called inside
  // collectEvidence(); export them from evidence.ts the same way the
  // others already are, then wire in here
} from "../evidence.js";
import { getDeployerHistory } from "../state.js";
import { POOL_TOKENS_ABI, ERC20_ABI } from "../utils/constants.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

// ─── Tool schemas ─────────────────────────────────────────────────────────────

export const AGENT_TOOLS = [
  // add a `tier` field to every existing entry so the system prompt and
  // agent-loop.ts can reference ordering without hardcoding tool names
  {
    name: "getHolderLedger",
    tier: 4,
    description: "Fetch top holder balances and % of supply for the token. Returns a map of addresses to balances and percentage breakdown.",
    parameters: {
      type: "object",
      properties: {
        tokenAddress: { type: "string", description: "The token contract address" },
        poolAddress: { type: "string", description: "The pool address to exclude from holder analysis" },
      },
      required: ["tokenAddress", "poolAddress"],
    },
  },
  {
    name: "getSourceCode",
    tier: 1,
    description: "Fetch verified source code from Etherscan and flag suspicious functions and secondary-admin patterns. Returns source verification status and any suspicious function snippets.",
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
  {
    name: "checkLpLock",
    tier: 2,
    description: "Check whether the LP position is burned, locked, or held by an EOA. Returns the LP token ID, position owner, and lock status.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "getDeployerHistory",
    tier: 3,
    description: "Check if this deployer address has launched tokens before. Returns list of prior token addresses from persistent state.",
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
    description: "Check how many contracts this deployer created in the 15min/1h/24h window before deploy.",
    parameters: {
      type: "object",
      properties: { deployerAddress: { type: "string" }, deployBlockTimestamp: { type: "number" } },
      required: ["deployerAddress", "deployBlockTimestamp"],
    },
  },
  {
    name: "getTradeHistory",
    tier: 5,
    description: "Scan swap events for wash-trading / bot-volume patterns. Returns total swaps, unique traders, buy/sell counts, and round-trip analysis.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "runSellTest",
    tier: 6,
    description: "Simulate a sell from a given holder at a given % of their balance to test for honeypot behavior. Returns whether the sell would succeed.",
    parameters: {
      type: "object",
      properties: {
        holderAddress: { type: "string", description: "The holder address to test" },
        amountPct: { type: "number", description: "Percentage of holder's balance to sell (e.g., 5 for 5%, 50 for 50%)" },
      },
      required: ["holderAddress", "amountPct"],
    },
  },
] as const;

// ─── Tool context ─────────────────────────────────────────────────────────────

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
  // Current decision state for the agent loop
  decision?: IterationDecision;
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<{ output: unknown; decision: IterationDecision }> {
  const warnings: string[] = [];
  const decision: IterationDecision = ctx.decision ?? {
    runningScore: 0,
    bandProximity: "deep",
    unresolvedMandatory: [],
    reason: "Initial call",
    action: "continue",
  };

  switch (name) {
    case "getHolderLedger": {
      const fromBlock = ctx.deployBlock > 10_000n ? ctx.deployBlock - 10_000n : 0n;
      const result = await scanHolderBalances(
        ctx.client,
        ctx.tokenAddress,
        fromBlock,
        warnings
      );
      
      // Convert to a more usable format for the LLM
      const totalSupply = await ctx.client.readContract({
        address: ctx.tokenAddress,
        abi: ERC20_ABI,
        functionName: "totalSupply",
      }) as bigint;

      const holders = [];
      for (const [addr, bal] of result.balances.entries()) {
        if (addr.toLowerCase() !== ctx.poolAddress.toLowerCase() && bal > 0n) {
          holders.push({
            address: addr,
            balance: bal.toString(),
            pct: totalSupply > 0n ? Number((bal * 10_000n) / totalSupply) / 100 : 0,
          });
        }
      }
      
      // Sort by balance and return top 10
      holders.sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));
      
      return {
        output: {
          topHolders: holders.slice(0, 10),
          scanPartial: result.partial,
          scanFailed: result.failed,
          warnings,
        },
        decision,
      };
    }

    case "getSourceCode": {
      const result = await checkSourceVerification(
        ctx.client,
        ctx.tokenAddress,
        warnings,
        args.ownershipRenounced as boolean | null,
        args.ownerAddress as string | null,
        ctx.isProxy
      );
      return { output: { ...result, warnings }, decision };
    }

    case "runSellTest": {
      const result = await runSellTest(
        ctx.client,
        ctx.tokenAddress,
        ctx.poolAddress,
        args.holderAddress as Address,
        args.amountPct as number,
        warnings
      );
      return { output: { ...result, warnings }, decision };
    }

    case "checkLpLock": {
      const result = await checkLpLockStatus(
        ctx.client,
        ctx.poolAddress,
        ctx.deployBlock,
        warnings
      );
      return { output: { ...result, warnings }, decision };
    }

    case "getDeployerHistory": {
      if (!ctx.state) {
        return {
          output: { deployerSeenBefore: false, deployerPriorTokens: [], warnings: ["No state available for deployer history"] },
          decision,
        };
      }
      const priorTokens = getDeployerHistory(ctx.state, args.deployerAddress as string);
      return {
        output: {
          deployerSeenBefore: priorTokens.length > 0,
          deployerPriorTokens: priorTokens,
          warnings,
        },
        decision,
      };
    }

    case "getTradeHistory": {
      // Determine if the target token is token0 or token1 in the pool
      let token0IsTarget = false;
      try {
        const token0 = await ctx.client.readContract({
          address: ctx.poolAddress,
          abi: POOL_TOKENS_ABI,
          functionName: "token0",
        }) as string;
        token0IsTarget = token0.toLowerCase() === ctx.tokenAddress.toLowerCase();
      } catch (err) {
        warnings.push(`Failed to read pool token0/token1: ${err instanceof Error ? err.message : String(err)}`);
      }

      const result = await scanTradeActivity(
        ctx.client,
        ctx.poolAddress,
        ctx.deployBlock,
        token0IsTarget,
        warnings
      );
      
      const buySellRatio = result.sellCount > 0 ? result.buyCount / result.sellCount : null;
      const roundTripTraderPct = result.uniqueTraders > 0
        ? (result.roundTripTraders.length / result.uniqueTraders) * 100
        : null;

      return {
        output: {
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
        },
        decision,
      };
    }

    case "getDeployerVelocity": {
      const etherscanApiKey = process.env.ETHERSCAN_API_KEY;
      if (!etherscanApiKey) {
        return {
          output: {
            deploysLast15Min: 0,
            deploysLastHour: 0,
            deploysLast24h: 0,
            recentContracts: [],
            warnings: ["ETHERSCAN_API_KEY not set"],
          },
          decision,
        };
      }
      const result = await checkDeployerVelocity(
        args.deployerAddress as string,
        args.deployBlockTimestamp as number,
        etherscanApiKey,
        warnings
      );
      return { output: { ...result, warnings }, decision };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}