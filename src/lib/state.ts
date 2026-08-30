/**
 * state.ts — Redis-backed persistence for the Telegram bot.
 *
 * Tracks postedTokens so a token discovered in overlapping scan windows
 * is never posted twice, and survives bot restarts.
 *
 * Previously this persisted to a local `bot-state.json` file on disk.
 * It now persists to the same Upstash Redis instance already used by
 * analysis-store.ts (via UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN),
 * under a single key so bot state survives restarts and works across
 * multiple/ephemeral hosts (e.g. serverless or container redeploys where
 * local disk isn't persisted).
 */

import { Redis } from "@upstash/redis";
import type { Venue } from "./utils/constants.js";
import type { BotState, LiquiditySnapshot, WatchlistEntry } from "./utils/interface.js";

// Re-export types for other modules
export type { BotState, LiquiditySnapshot, WatchlistEntry };

// ─── Redis client ────────────────────────────────────────────────────────────

const STATE_KEY = "bot:state";

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

let redisClient: Redis | null = null;

/**
 * Initialize the Upstash Redis client if credentials are available.
 * Returns null if credentials are missing (graceful degradation — the bot
 * still runs, but state will not survive a restart).
 */
function getRedisClient(): Redis | null {
  if (redisClient) return redisClient;

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.warn("[state] Upstash credentials not set — bot state will not persist across restarts");
    return null;
  }

  try {
    redisClient = new Redis({
      url: UPSTASH_URL,
      token: UPSTASH_TOKEN,
    });
    return redisClient;
  } catch (err) {
    console.error("[state] Failed to initialize Upstash client:", err);
    return null;
  }
}

function emptyState(): BotState {
  return { postedTokens: [], deployerHistory: {}, liquidityHistory: {}, watchlist: {}, lastScannedBlock: null };
}

// ─── Load / save ──────────────────────────────────────────────────────────────

export async function loadState(): Promise<BotState> {
  const client = getRedisClient();
  if (!client) return emptyState();

  try {
    const data = await client.get(STATE_KEY);
    if (!data) return emptyState();

    // Upstash auto-deserializes plain objects; fall back to JSON.parse in
    // case a value was ever written as a raw JSON string.
    const parsed = (typeof data === "string" ? JSON.parse(data) : data) as Partial<BotState>;
    const watchlist = parsed.watchlist ?? {};
    // Backwards compatibility: add default venue for existing watchlist entries
    for (const key in watchlist) {
      if (!watchlist[key].venue) {
        watchlist[key].venue = "v3"; // existing entries are V3
      }
    }
    return {
      postedTokens: parsed.postedTokens ?? [],
      deployerHistory: parsed.deployerHistory ?? {},
      liquidityHistory: parsed.liquidityHistory ?? {},
      watchlist,
      lastScannedBlock: parsed.lastScannedBlock ?? null
    };
  } catch (err) {
    console.warn(`[state] Could not load state from Redis, starting fresh: ${err}`);
    return emptyState();
  }
}

/**
 * Persist state to Redis.
 *
 * Fire-and-forget by design (same call-site contract as the old synchronous
 * writeFileSync): callers scattered throughout the bot call `saveState()` 
 * without awaiting it. The write happens asynchronously in the background;
 * failures are logged, not thrown. If a caller needs a durability guarantee
 * before proceeding, use `saveStateAsync()` instead and await it.
 */
export function saveState(s: BotState): void {
  void saveStateAsync(s);
}

export async function saveStateAsync(s: BotState): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  try {
    await client.set(STATE_KEY, s);
  } catch (err) {
    console.error(`[state] Failed to persist state to Redis: ${err}`);
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
  // Note: caller must call saveState() after batch operations
}

export function addToWatchlist(state: BotState, tokenAddress: string, poolAddress: string, pairedAsset: string, venue: Venue): void {
  const key = tokenAddress.toLowerCase();
  if (!state.watchlist[key]) {
    state.watchlist[key] = {
      tokenAddress: tokenAddress.toLowerCase(),
      poolAddress: poolAddress.toLowerCase(),
      pairedAsset: pairedAsset.toLowerCase(),
      venue,
      firstPostedTimestamp: Date.now(),
    };
    saveState(state);
  }
}

export function getWatchlistTokens(state: BotState, maxAgeMinutes: number): WatchlistEntry[] {
  const cutoff = Date.now() - (maxAgeMinutes * 60 * 1000);
  return Object.values(state.watchlist).filter(entry => entry.firstPostedTimestamp > cutoff);
}
