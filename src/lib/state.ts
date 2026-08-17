/**
 * state.ts — JSON-file persistence for the Telegram bot.
 *
 * Tracks postedTokens so a token discovered in overlapping scan windows
 * is never posted twice, and survives bot restarts.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BotState {
  /** Lower-cased token addresses already auto-posted. */
  postedTokens: string[];
  /** Deployer history: maps lower-cased deployer address to array of token addresses they've deployed. */
  deployerHistory: Record<string, string[]>;
}

// ─── Path ─────────────────────────────────────────────────────────────────────

const STATE_PATH = "./bot-state.json";

// ─── Load / save ──────────────────────────────────────────────────────────────

export function loadState(): BotState {
  if (!existsSync(STATE_PATH)) return { postedTokens: [], deployerHistory: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as Partial<BotState>;
    return { postedTokens: parsed.postedTokens ?? [], deployerHistory: parsed.deployerHistory ?? {} };
  } catch (err) {
    console.warn(`[state] Could not parse ${STATE_PATH}, starting fresh: ${err}`);
    return { postedTokens: [], deployerHistory: {} };
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

export function getDeployerHistory(state: BotState, deployerAddress: string): string[] {
  const key = deployerAddress.toLowerCase();
  return state.deployerHistory[key] ?? [];
}

export function recordDeployerToken(state: BotState, deployerAddress: string, tokenAddress: string): void {
  const key = deployerAddress.toLowerCase();
  if (!state.deployerHistory[key]) {
    state.deployerHistory[key] = [];
  }
  const tokenLower = tokenAddress.toLowerCase();
  if (!state.deployerHistory[key].includes(tokenLower)) {
    state.deployerHistory[key].push(tokenLower);
  }
  saveState(state);
}
