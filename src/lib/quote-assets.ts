/**
 * quote-assets.ts — live quote-asset list for the Uniswap pool scanner.
 *
 * Fetches Coingecko's Base token list at startup and keeps it fresh with a
 * background refresh every 6 hours.  Throws on fetch failure — the bot should
 * not start with a stale or missing list.
 *
 * Sync API (safe to call from the hot scan path):
 *   isKnownQuoteAsset(address)          → boolean
 *   getQuoteAssetLabel(address, fallback) → string
 *
 * Async init (call once at startup, before any scanning):
 *   initQuoteAssets()                   → Promise<void>  (throws on failure)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

// ─── Coingecko endpoint ───────────────────────────────────────────────────────

const COINGECKO_BASE_LIST_URL = "https://tokens.coingecko.com/base/all.json";

/** Cache TTL: 6 hours in milliseconds. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Flat-file cache — same convention as bot-state.json. */
const CACHE_PATH = "./quote-assets-cache.json";

// ─── In-memory state ──────────────────────────────────────────────────────────

/** Lower-cased address → ticker symbol. Empty until initQuoteAssets() resolves. */
const quoteAssetMap = new Map<string, string>();

// ─── Sync public API ──────────────────────────────────────────────────────────

export function isKnownQuoteAsset(address: string): boolean {
  return quoteAssetMap.has(address.toLowerCase());
}

export function getQuoteAssetLabel(address: string, fallback: string): string {
  return quoteAssetMap.get(address.toLowerCase()) ?? fallback;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

interface CacheFile {
  fetchedAt: number;
  tokens: Array<{ address: string; symbol: string }>;
}

function loadDiskCache(): CacheFile | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as CacheFile;
    if (typeof parsed.fetchedAt === "number" && Array.isArray(parsed.tokens)) {
      return parsed;
    }
  } catch {
    // malformed — treat as missing
  }
  return null;
}

function saveDiskCache(tokens: Array<{ address: string; symbol: string }>): void {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), tokens }, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[quote-assets] Failed to write cache: ${err instanceof Error ? err.message : err}`);
  }
}

function applyTokenList(tokens: Array<{ address: string; symbol: string }>): void {
  for (const t of tokens) {
    if (t.address && t.symbol) {
      quoteAssetMap.set(t.address.toLowerCase(), t.symbol);
    }
  }
}

// ─── Coingecko fetch ──────────────────────────────────────────────────────────

interface CoingeckoTokenList {
  tokens: Array<{ address: string; symbol: string; [key: string]: unknown }>;
}

/** Fetches the live list. Throws on any failure. */
async function fetchFromCoingecko(): Promise<Array<{ address: string; symbol: string }>> {
  const res = await fetch(COINGECKO_BASE_LIST_URL, {
    headers: {
      "User-Agent": "RugHound-Bot/1.0",
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Coingecko returned HTTP ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as CoingeckoTokenList;
  if (!Array.isArray(json?.tokens) || json.tokens.length === 0) {
    throw new Error("Coingecko response contained no tokens array");
  }

  return json.tokens.map((t) => ({ address: t.address, symbol: t.symbol }));
}

// ─── Background refresh ───────────────────────────────────────────────────────

async function refresh(): Promise<void> {
  try {
    const tokens = await fetchFromCoingecko();
    applyTokenList(tokens);
    saveDiskCache(tokens);
    console.log(`[quote-assets] Refreshed — ${quoteAssetMap.size} quote assets known`);
  } catch (err) {
    console.error(`[quote-assets] Background refresh failed: ${err instanceof Error ? err.message : err}`);
  }
  setTimeout(() => refresh(), CACHE_TTL_MS);
}

// ─── Public initialiser ───────────────────────────────────────────────────────

/**
 * Must be called once before any scan loop starts.
 *
 * - Fresh disk cache (< 6 h): applies it instantly, no network call.
 * - Stale / missing cache: fetches from Coingecko. Throws on failure so the
 *   bot never starts with an empty or outdated quote-asset list.
 *
 * Either way, schedules a background refresh for when the cache next expires.
 */
export async function initQuoteAssets(): Promise<void> {
  const cached = loadDiskCache();

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    applyTokenList(cached.tokens);
    const ageMin = Math.round((Date.now() - cached.fetchedAt) / 60_000);
    console.log(`[quote-assets] Loaded ${quoteAssetMap.size} quote assets from cache (age: ${ageMin} min)`);
    const remaining = CACHE_TTL_MS - (Date.now() - cached.fetchedAt);
    setTimeout(() => refresh(), remaining);
    return;
  }

  // Cache missing or stale — must fetch live. Throws if it fails.
  console.log("[quote-assets] Cache missing or stale — fetching from Coingecko…");
  const tokens = await fetchFromCoingecko();
  applyTokenList(tokens);
  saveDiskCache(tokens);
  console.log(`[quote-assets] Fetched ${quoteAssetMap.size} quote assets from Coingecko`);
  setTimeout(() => refresh(), CACHE_TTL_MS);
}
