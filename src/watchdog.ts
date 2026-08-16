import "dotenv/config";
import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import {
  UNISWAP_V3_FACTORY,
  POOL_CREATED_ABI,
  KNOWN_QUOTE_ASSETS,
  QUOTE_ASSET_LABELS,
} from "./lib/constants.js";
import { fetchTokenMetadata } from "./lib/erc20.js";

// ─── Env validation ───────────────────────────────────────────────────────────

function validateEnv(required: string[]): void {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`ERROR: Missing required environment variable(s): ${missing.join(", ")}`);
    console.error("Check your .env file and ensure all required keys are set.");
    process.exit(1);
  }
}

validateEnv(["RPC_URL"]);

const RPC_URL = process.env.RPC_URL as string;

// ─── RPC client ───────────────────────────────────────────────────────────────

const client = createPublicClient({
  chain: base,
  transport: http(RPC_URL, {
    retryCount: 3,
    retryDelay: 1500,
  }),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Shorten a hex address for display: 0x1234…abcd */
function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Given the two token addresses from a PoolCreated event, determine which is
 * the newly launched token and which is the known quote asset.
 *
 * Returns null for the new token address in ambiguous cases so callers can
 * decide how to handle them without crashing.
 */
function identifyTokens(
  token0: Address,
  token1: Address
): { newToken: Address | null; pairedWith: Address | null; ambiguity: string | null } {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  const t0known = KNOWN_QUOTE_ASSETS.has(t0);
  const t1known = KNOWN_QUOTE_ASSETS.has(t1);

  if (t0known && !t1known) {
    return { newToken: token1, pairedWith: token0, ambiguity: null };
  }
  if (t1known && !t0known) {
    return { newToken: token0, pairedWith: token1, ambiguity: null };
  }
  if (t0known && t1known) {
    return { newToken: null, pairedWith: null, ambiguity: "known/known — both are quote assets" };
  }
  // neither known
  return { newToken: token0, pairedWith: null, ambiguity: "unknown/unknown — neither token recognised as a quote asset" };
}

/** Format fee tier: 500 → "0.05%", 3000 → "0.30%", 10000 → "1.00%" */
function formatFee(fee: number): string {
  return `${(fee / 10_000).toFixed(2)}%`;
}

// ─── Startup banner ───────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════");
console.log("  RugHound - Base Token Monitor");
console.log("  Network : Base Mainnet (chain ID 8453)");
console.log(`  RPC     : ${RPC_URL}`);
console.log(`  Factory : ${UNISWAP_V3_FACTORY}  [Uniswap V3]`);
console.log("  Waiting for PoolCreated events… (Ctrl+C to stop)");
console.log("═══════════════════════════════════════════════════════════\n");

// ─── Event subscription ───────────────────────────────────────────────────────

const unwatch = client.watchContractEvent({
  address: UNISWAP_V3_FACTORY,
  abi: POOL_CREATED_ABI,
  eventName: "PoolCreated",

  async onLogs(logs) {
    for (const log of logs) {
      const { token0, token1, fee, pool } = log.args as {
        token0: Address;
        token1: Address;
        fee: number;
        tickSpacing: number;
        pool: Address;
      };

      const timestamp = new Date().toISOString();
      const txHash = log.transactionHash ?? "pending";

      const { newToken, pairedWith, ambiguity } = identifyTokens(token0, token1);

      // ── Ambiguous pool — log a brief notice and skip metadata fetch ──────
      if (ambiguity) {
        console.log(`[${timestamp}] POOL CREATED (ambiguous)`);
        console.log(`  Token0  : ${token0}`);
        console.log(`  Token1  : ${token1}`);
        console.log(`  Note    : ${ambiguity}`);
        console.log(`  Pool    : ${pool}`);
        console.log(`  Tx      : ${txHash}`);
        console.log();
        continue;
      }

      // ── Fetch metadata for the new token ─────────────────────────────────
      let meta;
      try {
      meta = await fetchTokenMetadata(client as any, newToken!);
      } catch (err) {
        console.error(`[rughound] fetchTokenMetadata failed for ${newToken}: ${err}`);
        continue;
      }

      // ── Resolve paired asset label ────────────────────────────────────────
      const pairedLabel = pairedWith
        ? (QUOTE_ASSET_LABELS[pairedWith.toLowerCase()] ?? shortAddr(pairedWith))
        : "unknown";

      // ── Structured log line ───────────────────────────────────────────────
      console.log(`┌─ NEW TOKEN DETECTED ─────────────────────────────────── ${timestamp}`);
      console.log(`│  Address  : ${newToken}`);
      console.log(`│  Name     : ${meta.name}`);
      console.log(`│  Symbol   : ${meta.symbol}`);
      console.log(`│  Decimals : ${meta.decimals}`);
      console.log(`│  Supply   : ${meta.totalSupplyFormatted} ${meta.symbol}`);
      console.log(`│  Paired   : ${pairedLabel}${pairedWith ? ` (${pairedWith})` : ""}`);
      console.log(`│  Fee tier : ${formatFee(fee)}`);
      console.log(`│  Pool     : ${pool}`);
      console.log(`│  Tx       : ${txHash}`);
      console.log(`│  BaseScan : https://basescan.org/tx/${txHash}`);
      console.log("└──────────────────────────────────────────────────────────\n");
    }
  },

  onError(error) {
    // Log but do not rethrow — the watch loop must stay alive
    console.error(`[rughound] RPC error: ${error.message}`);
  },
});

// ─── Clean shutdown ───────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\n[rughound] Shutting down…");
  unwatch();
  process.exit(0);
});
