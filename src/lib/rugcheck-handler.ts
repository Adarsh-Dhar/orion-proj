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
 *   answerTokenQuestion(client, address, question, mode) — run full pipeline, return result or error
 */

import { type Address, type PublicClient } from "viem";
import { fetchTokenMetadata }                from "./erc20.js";
import { resolveTokenPool, findContractDeployBlock } from "./scan-engine.js";
import { runRugCheckLLM }                    from "./rugcheck.js";
import type { RugCheckResult }               from "./rugcheck-types.js";

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

// ─── Success / failure union ──────────────────────────────────────────────────

export interface TokenMeta {
  name:                 string;
  symbol:               string;
  decimals:             number;
  totalSupply:          bigint;
  totalSupplyFormatted: string;
}

export type HandlerSuccess = { result: RugCheckResult; meta: TokenMeta };
export type HandlerError   = { error: string };
export type HandlerOutcome = HandlerSuccess | HandlerError;

// ─── Main pipeline ────────────────────────────────────────────────────────────

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
  mode: "alert" | "chat" = "chat"
): Promise<HandlerOutcome> {

  // ── 1. Resolve pool ─────────────────────────────────────────────────────
  let resolved;
  try {
    resolved = await resolveTokenPool(client, tokenAddress);
  } catch (err) {
    return { error: `Pool resolution failed: ${err}` };
  }
  if (!resolved) {
    return { error: `No Uniswap V3 pool found for ${tokenAddress} on Base. The token may not have launched yet or uses a different DEX.` };
  }

  // ── 2. Fetch metadata ───────────────────────────────────────────────────
  let meta: TokenMeta;
  try {
    meta = await fetchTokenMetadata(client, tokenAddress) as TokenMeta;
  } catch (err) {
    return { error: `Metadata fetch failed: ${err}` };
  }

  // ── 3. Deploy block ─────────────────────────────────────────────────────
  let deployBlock: bigint;
  try {
    deployBlock = await findContractDeployBlock(client, tokenAddress);
  } catch (err) {
    return { error: `Deploy block search failed: ${err}` };
  }

  // ── 4. LLM rug check ────────────────────────────────────────────────────
  try {
    const result = await runRugCheckLLM(
      client,
      tokenAddress,
      resolved.poolAddress,
      resolved.pairedLabel,
      deployBlock,
      meta,
      { userQuestion, mode }
    );
    return { result, meta };
  } catch (err) {
    return { error: `Rug check failed: ${err}` };
  }
}
