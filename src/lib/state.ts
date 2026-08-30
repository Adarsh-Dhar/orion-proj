/**
 * state.ts — Redis-backed persistence for the Telegram bot.
 *
 * Tracks posted tokens (so a token discovered in overlapping scan windows
 * is never posted twice), deployer history, liquidity snapshots, and the
 * watchlist — all backed by the same Upstash Redis instance already used by
 * analysis-store.ts (via UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
 *
 * Each concern gets its own native Redis structure rather than one big JSON
 * blob read/written on every change:
 *   - posted tokens      → Set                    (posted:tokens)
 *   - deployer history    → one Set per deployer   (deployer:<address>)
 *   - liquidity snapshots → one capped List per pool (liquidity:<pool>)
 *   - watchlist entries    → one String per token, with a TTL that replaces
 *                           the old manual age-filtering (watchlist:<token>)
 *   - last scanned block   → single String          (last-scanned-block)
 *
 * Every function that touches Redis is async — callers must await them.
 */

import { Redis } from "@upstash/redis";
import type { Venue } from "./utils/constants.js";
import type { LiquiditySnapshot, WatchlistEntry } from "./utils/interface.js";

// Re-export types for other modules
export type { LiquiditySnapshot, WatchlistEntry };

// ─── Redis client ────────────────────────────────────────────────────────────

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

let redisClient: Redis | null = null;
let warnedMissingCreds = false;

/**
 * Initialize the Upstash Redis client if credentials are available.
 * Returns null if credentials are missing (graceful degradation — the bot
 * still runs, but nothing persists across restarts).
 */
function getRedisClient(): Redis | null {
  if (redisClient) return redisClient;

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    if (!warnedMissingCreds) {
      console.warn("[state] Upstash credentials not set — bot state will not persist across restarts");
      warnedMissingCreds = true;
    }
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

// ─── Keys ─────────────────────────────────────────────────────────────────────

const POSTED_TOKENS_KEY = "posted:tokens";
const LAST_SCANNED_BLOCK_KEY = "last-scanned-block";
const deployerKey = (address: string) => `deployer:${address.toLowerCase()}`;
const liquidityKey = (poolAddress: string) => `liquidity:${poolAddress.toLowerCase()}`;
const watchlistKey = (tokenAddress: string) => `watchlist:${tokenAddress.toLowerCase()}`;

/** Max liquidity snapshots kept per pool — mirrors the old array cap. */
const MAX_LIQUIDITY_SNAPSHOTS = 5;

/** Default TTL for watchlist entries — matches the old default max-age (2h). */
const DEFAULT_WATCHLIST_TTL_MINUTES = 120;

// ─── Posted tokens ─────────────────────────────────────────────────────────────

export async function alreadyPosted(tokenAddress: string): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  try {
    const result = await client.sismember(POSTED_TOKENS_KEY, tokenAddress.toLowerCase());
    return result === 1;
  } catch (err) {
    console.error(`[state] alreadyPosted failed for ${tokenAddress}:`, err);
    return false;
  }
}

export async function markPosted(tokenAddress: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  try {
    await client.sadd(POSTED_TOKENS_KEY, tokenAddress.toLowerCase());
  } catch (err) {
    console.error(`[state] markPosted failed for ${tokenAddress}:`, err);
  }
}

// ─── Deployer history ───────────────────────────────────────────────────────────

export async function getDeployerHistory(deployerAddress: string): Promise<string[]> {
  const client = getRedisClient();
  if (!client) return [];

  try {
    return await client.smembers<string[]>(deployerKey(deployerAddress));
  } catch (err) {
    console.error(`[state] getDeployerHistory failed for ${deployerAddress}:`, err);
    return [];
  }
}

export async function recordDeployerToken(deployerAddress: string, tokenAddress: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  try {
    await client.sadd(deployerKey(deployerAddress), tokenAddress.toLowerCase());
  } catch (err) {
    console.error(`[state] recordDeployerToken failed for ${deployerAddress}:`, err);
  }
}

// ─── Liquidity snapshots ────────────────────────────────────────────────────────

/**
 * Returns up to the last MAX_LIQUIDITY_SNAPSHOTS snapshots for a pool,
 * oldest first (same ordering the old array-based history used).
 */
export async function getLiquidityHistory(poolAddress: string): Promise<LiquiditySnapshot[]> {
  const client = getRedisClient();
  if (!client) return [];

  try {
    const raw = await client.lrange<LiquiditySnapshot>(liquidityKey(poolAddress), 0, -1);
    return raw ?? [];
  } catch (err) {
    console.error(`[state] getLiquidityHistory failed for ${poolAddress}:`, err);
    return [];
  }
}

export async function recordLiquiditySnapshot(poolAddress: string, snap: LiquiditySnapshot): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  const key = liquidityKey(poolAddress);
  try {
    await client.rpush(key, snap);
    // Keep only the most recent MAX_LIQUIDITY_SNAPSHOTS entries — LTRIM keeps
    // indices [start, end] and drops everything outside that range.
    await client.ltrim(key, -MAX_LIQUIDITY_SNAPSHOTS, -1);
  } catch (err) {
    console.error(`[state] recordLiquiditySnapshot failed for ${poolAddress}:`, err);
  }
}

// ─── Watchlist ────────────────────────────────────────────────────────────────

/**
 * Adds a token to the watchlist if it isn't already on it. The entry
 * expires automatically after `ttlMinutes` (default 2h) — this replaces the
 * old manual age-filtering that used to happen at read time.
 */
export async function addToWatchlist(
  tokenAddress: string,
  poolAddress: string,
  pairedAsset: string,
  venue: Venue,
  ttlMinutes: number = DEFAULT_WATCHLIST_TTL_MINUTES
): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  const key = watchlistKey(tokenAddress);
  try {
    const existing = await client.get(key);
    if (existing) return; // already on the watchlist — leave its TTL untouched

    const entry: WatchlistEntry = {
      tokenAddress: tokenAddress.toLowerCase(),
      poolAddress: poolAddress.toLowerCase(),
      pairedAsset: pairedAsset.toLowerCase(),
      venue,
      firstPostedTimestamp: Date.now(),
    };
    await client.set(key, entry, { ex: Math.ceil(ttlMinutes * 60) });
  } catch (err) {
    console.error(`[state] addToWatchlist failed for ${tokenAddress}:`, err);
  }
}

/**
 * Returns all current watchlist entries. Expiry is handled entirely by
 * Redis TTL (set in addToWatchlist), so every key returned here is already
 * within the max-age window — no filtering needed at read time.
 */
export async function getWatchlistTokens(): Promise<WatchlistEntry[]> {
  const client = getRedisClient();
  if (!client) return [];

  try {
    const keys = await client.keys("watchlist:*");
    if (keys.length === 0) return [];

    const values = await client.mget<WatchlistEntry[]>(...keys);
    return values.filter((v): v is WatchlistEntry => v != null);
  } catch (err) {
    console.error("[state] getWatchlistTokens failed:", err);
    return [];
  }
}

// ─── Last scanned block ──────────────────────────────────────────────────────────

export async function getLastScannedBlock(): Promise<string | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    const value = await client.get<string>(LAST_SCANNED_BLOCK_KEY);
    return value ?? null;
  } catch (err) {
    console.error("[state] getLastScannedBlock failed:", err);
    return null;
  }
}

export async function setLastScannedBlock(block: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  try {
    await client.set(LAST_SCANNED_BLOCK_KEY, block);
  } catch (err) {
    console.error("[state] setLastScannedBlock failed:", err);
  }
}
