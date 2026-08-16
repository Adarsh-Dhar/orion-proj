import { type PublicClient, type Address, formatUnits } from "viem";
import { ERC20_ABI } from "./constants.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  /** Total supply formatted as a human-readable string using decimals */
  totalSupplyFormatted: string;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Fetch ERC-20 metadata for a token address.
 *
 * Each of the four calls is made independently so a single reverting function
 * (common on broken/malicious tokens on permissionless chains) doesn't blank
 * out the other fields. Failed calls fall back to safe placeholder values.
 */
export async function fetchTokenMetadata(
  client: PublicClient,
  address: Address
): Promise<TokenMetadata> {
  const baseArgs = {
    address,
    abi: ERC20_ABI,
  } as const;

  // Run all four reads in parallel — but catch each independently
  const [nameResult, symbolResult, decimalsResult, totalSupplyResult] =
    await Promise.allSettled([
      client.readContract({ ...baseArgs, functionName: "name" }),
      client.readContract({ ...baseArgs, functionName: "symbol" }),
      client.readContract({ ...baseArgs, functionName: "decimals" }),
      client.readContract({ ...baseArgs, functionName: "totalSupply" }),
    ]);

  const name =
    nameResult.status === "fulfilled" && typeof nameResult.value === "string"
      ? nameResult.value
      : "UNKNOWN";

  const symbol =
    symbolResult.status === "fulfilled" &&
    typeof symbolResult.value === "string"
      ? symbolResult.value
      : "UNKNOWN";

  const decimals =
    decimalsResult.status === "fulfilled" &&
    typeof decimalsResult.value === "number"
      ? decimalsResult.value
      : 0;

  const totalSupply =
    totalSupplyResult.status === "fulfilled" &&
    typeof totalSupplyResult.value === "bigint"
      ? totalSupplyResult.value
      : 0n;

  const totalSupplyFormatted =
    totalSupply > 0n && decimals > 0
      ? Number(formatUnits(totalSupply, decimals)).toLocaleString("en-US", {
          maximumFractionDigits: 2,
        })
      : totalSupply.toLocaleString();

  // Log individual failures for debugging without crashing
  if (nameResult.status === "rejected") {
    console.warn(`  [erc20] name() failed for ${address}: ${nameResult.reason}`);
  }
  if (symbolResult.status === "rejected") {
    console.warn(`  [erc20] symbol() failed for ${address}: ${symbolResult.reason}`);
  }
  if (decimalsResult.status === "rejected") {
    console.warn(`  [erc20] decimals() failed for ${address}: ${decimalsResult.reason}`);
  }
  if (totalSupplyResult.status === "rejected") {
    console.warn(`  [erc20] totalSupply() failed for ${address}: ${totalSupplyResult.reason}`);
  }

  return { name, symbol, decimals, totalSupply, totalSupplyFormatted };
}
