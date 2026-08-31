/**
 * rugcheck-handler.ts — shared pipeline used by the Telegram bot's sniper.
 *
 * Extracts the 4-step token-analysis flow that can be called from anywhere.
 *
 * Real-time only: every caller gets the same current-block evidence anchor.
 * See the doc comment on answerTokenQuestion() below.
 *
 * Exports:
 *   answerTokenQuestion(client, address, onProgress) — run full pipeline, return result or error
 */

import { type Address, type PublicClient } from "viem";
import { fetchTokenMetadata }                from "./erc20.js";
import { resolveTokenPool }                  from "./scan-engine.js";
import { runRugCheckLLM }                    from "./rugcheck.js";
import type { RugCheckResult }               from "./rugcheck-types.js";
import type { HandlerSuccess, HandlerError, HandlerOutcome, TokenMeta } from "./utils/interface.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

// ─── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Full 4-step rug-check pipeline — real-time only:
 *   1. Resolve Uniswap V3/V4 pool for the token
 *   2. Fetch ERC-20 metadata (name, symbol, supply)
 *   3. Use the current block as the evidence-collection anchor
 *   4. Run LLM rug check in alert mode
 *
 * This used to binary-search the token's exact historical deploy block
 * (~26 RPC calls) and then have evidence.ts scan Etherscan logs all the way
 * back to it. That historical-log path is now removed: Base is on
 * Etherscan's free tier, which blocks the `logs` module entirely
 * ("Free API access is not supported for this chain"), so wide historical
 * scans just failed and returned empty evidence anyway. Every query now
 * uses the same real-time approach: anchor on the current block and let
 * evidence.ts pull whatever is reachable from there (current owner/balances/LP
 * state, etc.) via live reads instead of historical log reconstruction.
 * The report format is unchanged — it's the same formatRugReport() output.
 *
 * Returns either { result, meta } on success or { error } on failure so
 * callers can pattern-match without try/catch.
 */
export async function answerTokenQuestion(
  client: AnyClient,
  tokenAddress: Address,
  onProgress?: (step: string, message: string) => void
): Promise<HandlerOutcome> {
  console.log(`[rugcheck-handler] Starting analysis for ${tokenAddress} in alert mode`);
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[rugcheck-handler] Contract validation failed:`, err);
    return { error: `Contract validation failed: ${msg}` };
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[rugcheck-handler] Step 1/4 failed:`, err);
    return { error: `Pool resolution failed: ${msg}` };
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[rugcheck-handler] Step 2/4 failed:`, err);
    return { error: `Metadata fetch failed: ${msg}` };
  }

  // ── 3. Evidence anchor block (real-time — no historical binary search) ───
  console.log(`[rugcheck-handler] Step 3/4: Using current block as evidence anchor...`);
  onProgress?.("deploy", "Reading current chain state...");
  let deployBlock: bigint;
  try {
    // Always the current block now — no more binary-searching the token's
    // real historical deploy block. That search only mattered because
    // evidence.ts used it as the start of a wide historical log scan, and
    // that scan is gone (see the doc comment above). Falls back to 0n if the
    // RPC stalls; evidence collection handles that the same way it always
    // did for sniper-path tokens.
    try {
      deployBlock = await Promise.race([
        client.getBlockNumber(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("getBlockNumber timeout")), 8_000)
        ),
      ]);
      console.log(`[rugcheck-handler] Step 3/4: Using current block ${deployBlock}`);
    } catch {
      deployBlock = 0n;
      console.warn(`[rugcheck-handler] Step 3/4: getBlockNumber timed out — using block 0`);
    }
    onProgress?.("deploy_done", "Chain state read successfully");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[rugcheck-handler] Step 3/4 failed:`, err);
    return { error: `Couldn't read current block — the RPC may be rate-limited. Try again in a moment. (${msg})` };
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
      { mode: "alert", venue: resolved.venue }
    );
    console.log(`[rugcheck-handler] Step 4/4: LLM check completed in ${Date.now() - startTime}ms`);
    console.log(`[rugcheck-handler] Total analysis time: ${Date.now() - startTime}ms`);
    onProgress?.("llm_done", "Analysis completed successfully");
    return { result, meta };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[rugcheck-handler] Step 4/4 failed after ${Date.now() - startTime}ms:`, err);
    return { error: `Rug check failed: ${msg}` };
  }
}
