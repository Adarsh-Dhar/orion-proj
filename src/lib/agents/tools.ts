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
  checkSourceVerification,
  runSellTest as runSellTestEvidence,
  checkDeployerVelocity,
} from "../evidence.js";
import { getDeployerHistory } from "../state.js";

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
      const priorTokens = await getDeployerHistory(args.deployerAddress as string);
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

// ─── holder-distribution-agent: no tools — DELETED (real-time-only mode) ────
// getHolderLedger used to call scanHolderBalances (a historical Transfer-log
// walk); both are gone. The agent now scores directly off the
// empty/unverified defaults already present in TokenEvidence
// (deployerPct, top5HoldersPct, top5Holders, preSeededWallets, preSeededPct).

export const HOLDER_DISTRIBUTION_TOOLS = [] as const;

export async function dispatchHolderDistributionTool(
  name: string,
  _args: Record<string, unknown>,
  _ctx: ToolContext
): Promise<unknown> {
  throw new Error(`Unknown tool for holder-distribution-agent: ${name}`);
}

// ─── lp-honeypot-agent: runSellTest ──────────────────────────────────────────
// checkLpLock — DELETED (real-time-only mode). Used to call checkLpLockStatus
// (a historical Mint/ModifyLiquidity-log scan); both are gone. The agent now
// scores directly off the "unverified" default already present in
// TokenEvidence.lpPositionStatus.

export const LP_HONEYPOT_TOOLS = [
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

// ─── trading-activity-agent: no tools — DELETED (real-time-only mode) ───────
// getTradeHistory used to call scanTradeActivity (a historical Swap-log
// walk); both are gone. The agent now scores directly off the zeroed
// defaults already present in TokenEvidence (totalSwaps, uniqueTraders,
// buyCount, sellCount, roundTripTraderPct, topTraderSwapSharePct).

export const TRADING_ACTIVITY_TOOLS = [] as const;

export async function dispatchTradingActivityTool(
  name: string,
  _args: Record<string, unknown>,
  _ctx: ToolContext
): Promise<unknown> {
  throw new Error(`Unknown tool for trading-activity-agent: ${name}`);
}
