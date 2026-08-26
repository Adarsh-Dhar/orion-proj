/**
 * rugcheck-handler.ts — shared pipeline used by both chat.ts and the
 * Telegram bot's message handler.
 *
 * Extracts the 5-step token-analysis flow that previously lived inline in
 * chat.ts so it can be called from anywhere without copy-pasting.
 *
 * Exports:
 *   extractAddress(text)                         — pull first 0x address from string
 *   stripAddress(text, address)                  — remove address from text, return remainder
 *   answerTokenQuestion(client, address, question, mode, state) — run full pipeline, return result or error
 */

import { type Address, type PublicClient } from "viem";
import { fetchTokenMetadata }                from "./erc20.js";
import { resolveTokenPool, findContractDeployBlock } from "./scan-engine.js";
import { runRugCheckLLM }                    from "./rugcheck.js";
import type { RugCheckResult }               from "./rugcheck-types.js";
import type { BotState }                     from "./state.js";
import type { HandlerSuccess, HandlerError, HandlerOutcome, TokenMeta } from "./utils/interface.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

// ─── Address extractor ────────────────────────────────────────────────────────

/** Returns the first 0x-prefixed 40-hex-char address found in a string, or null. */
export function extractAddress(text: string): Address | null {
  const match = text.match(/0x[a-fA-F0-9]{40}/);
  return match ? (match[0] as Address) : null;
}

/** Removes the first occurrence of `address` from `text`, trimmed. */
export function stripAddress(text: string, address: Address): string {
  return text.replace(address, "").trim();
}

// ─── Main pipeline ────────────────────────────────────────────────────────────// ─── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Full 5-step rug-check pipeline:
 *   1. Resolve Uniswap V3 pool for the token
 *   2. Fetch ERC-20 metadata (name, symbol, supply)
 *   3. Binary-search the exact deploy block
 *   4. Run LLM rug check (optionally answering userQuestion, in alert or chat mode)
 *
 * Returns either { result, meta } on success or { error } on failure so
 * callers can pattern-match without try/catch.
 */
export async function answerTokenQuestion(
  client: AnyClient,
  tokenAddress: Address,
  userQuestion?: string,
  mode: "alert" | "chat" = "chat",
  state?: BotState,
  onProgress?: (step: string, message: string) => void,
  quickMode?: boolean,
  sniperMode?: boolean
): Promise<HandlerOutcome> {
  console.log(`[rugcheck-handler] Starting analysis for ${tokenAddress} in ${mode} mode`);
  const startTime = Date.now();

  // Quick validation: check if contract exists
  console.log(`[rugcheck-handler] Validating contract exists...`);
  onProgress?.("validating", "Checking if contract exists on-chain...");
  try {
    const code = await client.getBytecode({ address: tokenAddress });
    if (code === "0x" || code === "0x0") {
      console.log(`[rugcheck-handler] Contract does not exist or has no code`);
      return { error: `Contract ${tokenAddress} does not exist or has no code on Base. Please verify the address.` };
    }
    console.log(`[rugcheck-handler] Contract validation passed in ${Date.now() - startTime}ms`);
    onProgress?.("validated", "Contract validated successfully");
  } catch (err) {
    console.error(`[rugcheck-handler] Contract validation failed:`, err);
    return { error: `Contract validation failed: ${err}` };
  }

  // ── 1. Resolve pool ─────────────────────────────────────────────────────
  console.log(`[rugcheck-handler] Step 1/4: Resolving pool for ${tokenAddress}...`);
  onProgress?.("pool", "Finding Uniswap pool for this token...");
  let resolved;
  try {
    resolved = await resolveTokenPool(client, tokenAddress);
    console.log(`[rugcheck-handler] Step 1/4: Pool resolved in ${Date.now() - startTime}ms`);
    onProgress?.("pool_done", "Pool found successfully");
  } catch (err) {
    console.error(`[rugcheck-handler] Step 1/4 failed:`, err);
    return { error: `Pool resolution failed: ${err}` };
  }
  if (!resolved) {
    console.log(`[rugcheck-handler] Step 1/4: No pool found`);
    return { error: `No Uniswap pool found for ${tokenAddress} on Base. The token may not have launched yet, or it uses a DEX other than Uniswap V3/V4.` };
  }

  // ── 2. Fetch metadata ───────────────────────────────────────────────────
  console.log(`[rugcheck-handler] Step 2/4: Fetching metadata...`);
  onProgress?.("metadata", "Fetching token metadata (name, symbol, supply)...");
  let meta: TokenMeta;
  try {
    meta = await fetchTokenMetadata(client, tokenAddress) as TokenMeta;
    console.log(`[rugcheck-handler] Step 2/4: Metadata fetched in ${Date.now() - startTime}ms`);
    onProgress?.("metadata_done", "Metadata fetched successfully");
  } catch (err) {
    console.error(`[rugcheck-handler] Step 2/4 failed:`, err);
    return { error: `Metadata fetch failed: ${err}` };
  }

  // ── 3. Deploy block ─────────────────────────────────────────────────────
  console.log(`[rugcheck-handler] Step 3/4: Finding deploy block...`);
  onProgress?.("deploy", "Searching for token deployment block...");
  let deployBlock: bigint;
  try {
    // In sniper mode, use current block instead of expensive binary search
    if (sniperMode) {
      deployBlock = await client.getBlockNumber();
      console.log(`[rugcheck-handler] Step 3/4: Using current block ${deployBlock} (sniper mode)`);
    } else {
      deployBlock = await findContractDeployBlock(client, tokenAddress);
      console.log(`[rugcheck-handler] Step 3/4: Deploy block found in ${Date.now() - startTime}ms`);
    }
    onProgress?.("deploy_done", "Deploy block found successfully");
  } catch (err) {
    console.error(`[rugcheck-handler] Step 3/4 failed:`, err);
    return { error: `Deploy block search failed: ${err}` };
  }

  // ── 4. LLM rug check ────────────────────────────────────────────────────
  console.log(`[rugcheck-handler] Step 4/4: Running LLM rug check...`);
  onProgress?.("llm", "Running comprehensive security analysis with AI...");
  try {
    const result = await runRugCheckLLM(
      client,
      tokenAddress,
      resolved.poolAddress,
      resolved.pairedLabel,
      deployBlock,
      meta,
      { userQuestion, mode, state, venue: resolved.venue, quickMode, sniperMode }
    );
    console.log(`[rugcheck-handler] Step 4/4: LLM check completed in ${Date.now() - startTime}ms`);
    console.log(`[rugcheck-handler] Total analysis time: ${Date.now() - startTime}ms`);
    onProgress?.("llm_done", "Analysis completed successfully");
    return { result, meta };
  } catch (err) {
    console.error(`[rugcheck-handler] Step 4/4 failed after ${Date.now() - startTime}ms:`, err);
    return { error: `Rug check failed: ${err}` };
  }
}
