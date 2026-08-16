/**
 * state.ts — JSON-file persistence for the Twitter bot.
 *
 * Tracks postedTokens so a token discovered in overlapping scan windows
 * is never tweeted twice, and survives bot restarts.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BotState {
  /** Lower-cased token addresses already auto-posted. */
  postedTokens: string[];
}

// ─── Path ─────────────────────────────────────────────────────────────────────

const STATE_PATH = "./bot-state.json";

// ─── Load / save ──────────────────────────────────────────────────────────────

export function loadState(): BotState {
  if (!existsSync(STATE_PATH)) return { postedTokens: [] };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as Partial<BotState>;
    return { postedTokens: parsed.postedTokens ?? [] };
  } catch (err) {
    console.warn(`[state] Could not parse ${STATE_PATH}, starting fresh: ${err}`);
    return { postedTokens: [] };
  }
}

export function saveState(s: BotState): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), "utf-8");
  } catch (err) {
    console.error(`[state] Failed to write ${STATE_PATH}: ${err}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function alreadyPosted(state: BotState, tokenAddress: string): boolean {
  return state.postedTokens.includes(tokenAddress.toLowerCase());
}

export function markPosted(state: BotState, tokenAddress: string): void {
  const addr = tokenAddress.toLowerCase();
  if (!state.postedTokens.includes(addr)) state.postedTokens.push(addr);
  saveState(state);
}
