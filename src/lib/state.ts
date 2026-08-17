/**
 * state.ts — JSON-file persistence for the Telegram bot.
 *
 * Tracks postedTokens so a token discovered in overlapping scan windows
 * is never posted twice, and survives bot restarts.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LiquiditySnapshot {
  liquidity: string;
  blockNumber: string;
  ts: number;
}

export interface WatchlistEntry {
  tokenAddress: string;
  poolAddress: string;
  pairedAsset: string;
  firstPostedTimestamp: number;
}

export interface BotState {
  /** Lower-cased token addresses already auto-posted. */
  postedTokens: string[];
  /** Deployer history: maps lower-cased deployer address to array of token addresses they've deployed. */
  deployerHistory: Record<string, string[]>;
  /** Liquidity history: maps lower-cased pool address to array of snapshots. */
  liquidityHistory: Record<string, LiquiditySnapshot[]>;
  /** Watchlist: tokens to monitor for liquidity drops after initial posting. */
  watchlist: Record<string, WatchlistEntry>; // key: token address (lowercased)
}

// ─── Path ─────────────────────────────────────────────────────────────────────

const STATE_PATH = "./bot-state.json";

// ─── Load / save ──────────────────────────────────────────────────────────────

export function loadState(): BotState {
  if (!existsSync(STATE_PATH)) return { postedTokens: [], deployerHistory: {}, liquidityHistory: {}, watchlist: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as Partial<BotState>;
    return {
      postedTokens: parsed.postedTokens ?? [],
      deployerHistory: parsed.deployerHistory ?? {},
      liquidityHistory: parsed.liquidityHistory ?? {},
      watchlist: parsed.watchlist ?? {}
    };
  } catch (err) {
    console.warn(`[state] Could not parse ${STATE_PATH}, starting fresh: ${err}`);
    return { postedTokens: [], deployerHistory: {}, liquidityHistory: {}, watchlist: {} };
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

export function recordLiquiditySnapshot(state: BotState, poolAddress: string, snap: LiquiditySnapshot): void {
  const key = poolAddress.toLowerCase();
  const arr = state.liquidityHistory[key] ?? (state.liquidityHistory[key] = []);
  arr.push(snap);
  if (arr.length > 5) arr.shift(); // keep it small — don't need unbounded history
  saveState(state);
}

export function addToWatchlist(state: BotState, tokenAddress: string, poolAddress: string, pairedAsset: string): void {
  const key = tokenAddress.toLowerCase();
  if (!state.watchlist[key]) {
    state.watchlist[key] = {
      tokenAddress: tokenAddress.toLowerCase(),
      poolAddress: poolAddress.toLowerCase(),
      pairedAsset: pairedAsset.toLowerCase(),
      firstPostedTimestamp: Date.now(),
    };
    saveState(state);
  }
}

export function removeFromWatchlist(state: BotState, tokenAddress: string): void {
  const key = tokenAddress.toLowerCase();
  delete state.watchlist[key];
  saveState(state);
}

export function getWatchlistTokens(state: BotState, maxAgeMinutes: number): WatchlistEntry[] {
  const cutoff = Date.now() - (maxAgeMinutes * 60 * 1000);
  return Object.values(state.watchlist).filter(entry => entry.firstPostedTimestamp > cutoff);
}
