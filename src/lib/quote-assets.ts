/**
 * quote-assets.ts — quote-asset detection for the Uniswap pool scanner.
 *
 * Two separate concerns, kept deliberately separate:
 *
 * 1. GATE (isKnownQuoteAsset): is this address a legitimate base/quote
 *    pairing asset? Backed by the small curated CORE_QUOTE_ASSETS list only.
 *    This decides whether a pool looks like a genuine new-token launch.
 *
 * 2. LABEL (getQuoteAssetLabel): what should we call this address when
 *    displaying it? Backed by CORE_QUOTE_ASSETS first, then a much broader
 *    list fetched from Coingecko's Base token list (refreshed every 6h) as a
 *    cosmetic fallback, then the caller's own fallback (e.g. shortAddr()).
 *
 * The broad Coingecko list must never be used for (1) — it indexes
 * thousands of tokens (including low-quality/scam ones), so using it as the
 * "is this a real base asset" gate caused the scanner to misclassify pools
 * between two unrelated tokens as new-token-vs-base launches.
 *
 * Async init (call once at startup, before any scanning):
 *   initQuoteAssets()                   → Promise<void>  (throws on failure)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import type { Address } from "viem";

// ─── Curated core pairing assets ──────────────────────────────────────────────
//
// This is the actual gate for "is this pool a new-token-vs-base-asset launch".
// It is intentionally small and hand-picked — these are the only assets a
// legitimate new token is normally launched against on Base. It must NOT be
// replaced with the full Coingecko list: that list indexes thousands of
// tokens (including plenty of low-quality/scam ones), so using it as the
// gate caused two problems:
//   1. Pools between two unrelated/junk tokens were misclassified as
//      "new token vs. known base" launches whenever either side happened to
//      already be indexed by Coingecko for unrelated reasons.
//   2. identifyTokens() had to guess when neither side matched, and it
//      guessed wrong (see scan-engine.ts fix) — so effectively almost any
//      pool could end up being scanned as a "new token" launch.
export const CORE_QUOTE_ASSETS: ReadonlyArray<{ address: Address; label: string }> = [
  { address: "0x4200000000000000000000000000000000000006", label: "WETH"   },
  { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", label: "USDC"   },
  { address: "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", label: "USDbC"  },
  { address: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", label: "DAI"    },
  { address: "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22", label: "cbETH"  },
  { address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", label: "cbBTC"  },
  { address: "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452", label: "wstETH" },
  { address: "0x04c0599ae5a44757c0af6f9ec3b93da8976c150a", label: "weETH"  },
  { address: "0x940181a94a35a4569e4529a3cdfb74e38fd98631", label: "AERO"   },
  { address: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", label: "EURC"   },
] as const;

const CORE_QUOTE_MAP = new Map<string, string>(
  CORE_QUOTE_ASSETS.map((t) => [t.address.toLowerCase(), t.label])
);

// ─── Coingecko endpoint ───────────────────────────────────────────────────────

const COINGECKO_BASE_LIST_URL = "https://tokens.coingecko.com/base/all.json";

/** Cache TTL: 6 hours in milliseconds. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Flat-file cache — same convention as bot-state.json. */
const CACHE_PATH = "./quote-assets-cache.json";

// ─── In-memory state ──────────────────────────────────────────────────────────

/**
 * Lower-cased address → ticker symbol, from the broad Coingecko list.
 * This is ONLY used for display labels (e.g. showing a friendly symbol for
 * whatever token a new token happened to pair against) — it is never used
 * to decide whether something counts as a legitimate quote/base asset.
 * Empty until initQuoteAssets() resolves.
 */
const quoteAssetMap = new Map<string, string>();

// ─── Sync public API ──────────────────────────────────────────────────────────

/**
 * Is this address a legitimate base/quote pairing asset (WETH, USDC, etc.)?
 * This is the gate used by identifyTokens() to decide whether a pool looks
 * like a genuine new-token launch. Deliberately checks ONLY the small
 * curated CORE_QUOTE_ASSETS list — never the broad Coingecko list.
 */
export function isKnownQuoteAsset(address: string): boolean {
  return CORE_QUOTE_MAP.has(address.toLowerCase());
}

/**
 * Best-effort display label for an address. Checks the curated core list
 * first, then falls back to the broad Coingecko-derived list (cosmetic
 * only), then the caller-supplied fallback (e.g. a shortened address).
 */
export function getQuoteAssetLabel(address: string, fallback: string): string {
  const lower = address.toLowerCase();
  return CORE_QUOTE_MAP.get(lower) ?? quoteAssetMap.get(lower) ?? fallback;
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