/**
 * quote-assets.ts — quote-asset detection for the Uniswap pool scanner.
 *
 * Two separate concerns, kept deliberately separate:
 *
 * 1. GATE (isKnownQuoteAsset): is this address a legitimate base/quote
 *    pairing asset? Backed by a dynamically-fetched list of the top
 *    TOP_N_GATE_ASSETS Base-ecosystem tokens by market cap (Coingecko
 *    `/coins/markets?category=base-ecosystem`, resolved to Base contract
 *    addresses via `/coins/list?include_platform=true`). This decides
 *    whether a pool looks like a genuine new-token launch.
 *
 * 2. LABEL (getQuoteAssetLabel): what should we call this address when
 *    displaying it? Backed by the gate list first, then a much broader
 *    list fetched from Coingecko's full Base token list (refreshed every
 *    6h) as a cosmetic fallback, then the caller's own fallback (e.g.
 *    shortAddr()).
 *
 * The broad cosmetic Coingecko list must never be used for (1) — it
 * indexes thousands of tokens (including low-quality/scam ones), so using
 * it as the "is this a real base asset" gate caused the scanner to
 * misclassify pools between two unrelated tokens as new-token-vs-base
 * launches. The gate list itself is dynamic (top N by market cap within
 * the Base-ecosystem category) rather than hand-picked, but it is still a
 * *separate, narrower* list than the cosmetic one, refreshed and cached
 * the same way (Redis — same Upstash instance as state.ts / analysis-store.ts).
 *
 * Async init (call once at startup, before any scanning):
 *   initQuoteAssets()                   → Promise<void>  (throws on failure)
 */

import { Redis } from "@upstash/redis";
import type { Address } from "viem";

// ─── Gate list configuration ──────────────────────────────────────────────────
//
// How many Base-ecosystem tokens (ranked purely by market cap, no forced
// inclusions) count as legitimate pairing/quote assets for the gate.
const TOP_N_GATE_ASSETS = 100;

// ─── Emergency seed (NOT part of the ranked gate — resilience floor only) ────
//
// Used ONLY if the very first live fetch fails on a cold boot with no Redis
// cache available. Without this, a network hiccup at startup would leave
// isKnownQuoteAsset() gating against an empty set, which would make the
// scanner treat every pool as a "new token vs. unknown" launch — the
// opposite failure mode from before. This is a bare minimum keep-alive,
// not a ranking override: as soon as a live fetch succeeds, the gate is
// entirely replaced by the top-100-by-market-cap result with no forced
// members.
const EMERGENCY_SEED_ASSETS: ReadonlyArray<{ address: Address; label: string }> = [
  { address: "0x4200000000000000000000000000000000000006", label: "WETH" },
  { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", label: "USDC" },
] as const;

// ─── Gate list (dynamic) ──────────────────────────────────────────────────────
//
// Lower-cased address → ticker symbol. This is the actual gate for "is this
// pool a new-token-vs-base-asset launch". Populated by initQuoteAssets() /
// refreshGateAssets() from the top TOP_N_GATE_ASSETS Base-ecosystem tokens
// by market cap. Empty until initQuoteAssets() resolves (or holds the
// EMERGENCY_SEED_ASSETS if the very first fetch fails with no cache).
const gateAssetMap = new Map<string, string>();

/** Ordered array form of the gate list, kept in sync with gateAssetMap — used
 *  by scan-engine.ts to iterate quote-asset × fee-tier combinations. */
let gateAssetList: Array<{ address: Address; label: string }> = [];

function setGateAssets(tokens: Array<{ address: string; symbol: string }>): void {
  gateAssetMap.clear();
  gateAssetList = [];
  for (const t of tokens) {
    if (!t.address || !t.symbol) continue;
    const lower = t.address.toLowerCase() as Address;
    gateAssetMap.set(lower, t.symbol);
    gateAssetList.push({ address: lower, label: t.symbol });
  }
}

/**
 * Ordered list of current gate assets (top-N Base tokens by market cap).
 * Replacement for the old static CORE_QUOTE_ASSETS export — used by
 * scan-engine.ts to try every (quoteAsset × feeTier) combination.
 */
export function getCoreQuoteAssets(): ReadonlyArray<{ address: Address; label: string }> {
  return gateAssetList;
}

// ─── Coingecko endpoints ───────────────────────────────────────────────────────

const COINGECKO_BASE_LIST_URL = "https://tokens.coingecko.com/base/all.json";
const COINGECKO_MARKETS_URL =
  "https://api.coingecko.com/api/v3/coins/markets" +
  "?vs_currency=usd&category=base-ecosystem&order=market_cap_desc" +
  `&per_page=${TOP_N_GATE_ASSETS}&page=1&sparkline=false`;
const COINGECKO_COIN_LIST_URL =
  "https://api.coingecko.com/api/v3/coins/list?include_platform=true";

/** Cache TTL: 6 hours in milliseconds. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Redis cache keys — same Upstash instance/creds as state.ts and analysis-store.ts. */
const LABEL_CACHE_KEY = "quote-assets:labels";
const GATE_CACHE_KEY = "quote-assets:gate";

const FETCH_HEADERS = {
  "User-Agent": "RugHound-Bot/1.0",
  "Accept": "application/json",
};

// ─── Redis client ────────────────────────────────────────────────────────────

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

let redisClient: Redis | null = null;

/**
 * Initialize the Upstash Redis client if credentials are available.
 * Returns null if credentials are missing — the bot still runs, it just
 * refetches from Coingecko on every startup instead of using a cache.
 */
function getRedisClient(): Redis | null {
  if (redisClient) return redisClient;

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.warn("[quote-assets] Upstash credentials not set — quote-asset cache disabled, will fetch fresh on every startup");
    return null;
  }

  try {
    redisClient = new Redis({
      url: UPSTASH_URL,
      token: UPSTASH_TOKEN,
    });
    return redisClient;
  } catch (err) {
    console.error("[quote-assets] Failed to initialize Upstash client:", err);
    return null;
  }
}

// ─── In-memory state (cosmetic label list) ─────────────────────────────────────

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
 * like a genuine new-token launch. Deliberately checks ONLY the dynamic
 * top-N gate list — never the broad Coingecko list.
 */
export function isKnownQuoteAsset(address: string): boolean {
  return gateAssetMap.has(address.toLowerCase());
}

/**
 * Best-effort display label for an address. Checks the gate list first,
 * then falls back to the broad Coingecko-derived cosmetic list, then the
 * caller-supplied fallback (e.g. a shortened address).
 */
export function getQuoteAssetLabel(address: string, fallback: string): string {
  const lower = address.toLowerCase();
  return gateAssetMap.get(lower) ?? quoteAssetMap.get(lower) ?? fallback;
}

// ─── Cache helpers (generic, Redis-backed) ─────────────────────────────────────

interface CacheEntry {
  fetchedAt: number;
  tokens: Array<{ address: string; symbol: string }>;
}

async function loadRedisCache(key: string): Promise<CacheEntry | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    const data = await client.get(key);
    if (!data) return null;

    // Upstash auto-deserializes plain objects; fall back to JSON.parse in
    // case a value was ever written as a raw JSON string.
    const parsed = (typeof data === "string" ? JSON.parse(data) : data) as CacheEntry;
    if (typeof parsed.fetchedAt === "number" && Array.isArray(parsed.tokens)) {
      return parsed;
    }
  } catch (err) {
    console.warn(`[quote-assets] Failed to read cache (${key}) from Redis: ${err instanceof Error ? err.message : err}`);
  }
  return null;
}

async function saveRedisCache(key: string, tokens: Array<{ address: string; symbol: string }>): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  try {
    await client.set(key, { fetchedAt: Date.now(), tokens }, {
      ex: Math.ceil((CACHE_TTL_MS * 2) / 1000), // generous TTL safety net; refresh keeps it warm well before this
    });
  } catch (err) {
    console.warn(`[quote-assets] Failed to write cache (${key}) to Redis: ${err instanceof Error ? err.message : err}`);
  }
}

function applyLabelList(tokens: Array<{ address: string; symbol: string }>): void {
  for (const t of tokens) {
    if (t.address && t.symbol) {
      quoteAssetMap.set(t.address.toLowerCase(), t.symbol);
    }
  }
}

// ─── Coingecko fetch: cosmetic label list (unchanged) ──────────────────────────

interface CoingeckoTokenList {
  tokens: Array<{ address: string; symbol: string; [key: string]: unknown }>;
}

/** Fetches the full Base token list (cosmetic labels only). Throws on failure. */
async function fetchFromCoingecko(): Promise<Array<{ address: string; symbol: string }>> {
  const res = await fetch(COINGECKO_BASE_LIST_URL, {
    headers: FETCH_HEADERS,
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

// ─── Coingecko fetch: dynamic gate list (top-N by market cap) ─────────────────

interface CoingeckoMarketsEntry {
  id: string;
  symbol: string;
  market_cap_rank: number | null;
  [key: string]: unknown;
}

interface CoingeckoListEntry {
  id: string;
  symbol: string;
  platforms?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Fetches the top TOP_N_GATE_ASSETS Base-ecosystem tokens by market cap and
 * resolves each to its Base contract address.
 *
 * Two calls only (not one per token):
 *   1. /coins/markets?category=base-ecosystem&order=market_cap_desc — top N
 *      coin IDs ranked purely by market cap.
 *   2. /coins/list?include_platform=true — platforms.base contract address
 *      for every Coingecko coin, in a single response.
 * Step 2's result is joined against step 1's ranked IDs. Any coin without a
 * platforms.base entry (cross-chain listing with no real Base deployment)
 * is dropped — no forced inclusions, pure market-cap order.
 *
 * Throws on any failure (network, non-2xx, malformed body).
 */
async function fetchTopBaseTokensByMarketCap(): Promise<Array<{ address: string; symbol: string }>> {
  const [marketsRes, listRes] = await Promise.all([
    fetch(COINGECKO_MARKETS_URL, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(15_000) }),
    fetch(COINGECKO_COIN_LIST_URL, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(20_000) }),
  ]);

  if (!marketsRes.ok) {
    throw new Error(`Coingecko /coins/markets returned HTTP ${marketsRes.status} ${marketsRes.statusText}`);
  }
  if (!listRes.ok) {
    throw new Error(`Coingecko /coins/list returned HTTP ${listRes.status} ${listRes.statusText}`);
  }

  const markets = await marketsRes.json() as CoingeckoMarketsEntry[];
  const list = await listRes.json() as CoingeckoListEntry[];

  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error("Coingecko /coins/markets response was empty or malformed");
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("Coingecko /coins/list response was empty or malformed");
  }

  // id → Base contract address, from the full coin list.
  const platformById = new Map<string, string>();
  for (const entry of list) {
    const baseAddr = entry.platforms?.base;
    if (baseAddr) platformById.set(entry.id, baseAddr);
  }

  // Walk the market-cap-ranked results in order, resolving each to its Base
  // address. Drop anything with no Base deployment. No forced members.
  const resolved: Array<{ address: string; symbol: string }> = [];
  for (const coin of markets) {
    const addr = platformById.get(coin.id);
    if (!addr) continue; // ranked on Coingecko generally, but no Base contract
    resolved.push({ address: addr, symbol: coin.symbol.toUpperCase() });
  }

  if (resolved.length === 0) {
    throw new Error("No top-ranked Base-ecosystem coin resolved to a Base contract address");
  }

  return resolved.slice(0, TOP_N_GATE_ASSETS);
}

// ─── Background refresh ───────────────────────────────────────────────────────

async function refreshLabels(): Promise<void> {
  try {
    const tokens = await fetchFromCoingecko();
    applyLabelList(tokens);
    await saveRedisCache(LABEL_CACHE_KEY, tokens);
    console.log(`[quote-assets] Labels refreshed — ${quoteAssetMap.size} known`);
    setTimeout(() => refreshLabels(), CACHE_TTL_MS);
  } catch (err) {
    console.error(`[quote-assets] Label refresh failed: ${err instanceof Error ? err.message : err}`);
    // Retry in 15 min instead of the full 6-hour TTL so a temporary network
    // blip doesn't leave the label cache stale for hours.
    setTimeout(() => refreshLabels(), 15 * 60_000);
  }
}

async function refreshGateAssets(): Promise<void> {
  try {
    const tokens = await fetchTopBaseTokensByMarketCap();
    setGateAssets(tokens);
    await saveRedisCache(GATE_CACHE_KEY, tokens);
    console.log(`[quote-assets] Gate list refreshed — top ${gateAssetList.length} Base tokens by market cap`);
    setTimeout(() => refreshGateAssets(), CACHE_TTL_MS);
  } catch (err) {
    console.error(`[quote-assets] Gate refresh failed: ${err instanceof Error ? err.message : err}`);
    // Keep whatever gate list is currently in memory (last-good) rather than
    // clearing it — a transient failure should not empty the gate. Retry
    // sooner than the full TTL.
    setTimeout(() => refreshGateAssets(), 15 * 60_000);
  }
}

// ─── Public initialiser ───────────────────────────────────────────────────────

/**
 * Must be called once before any scan loop starts.
 *
 * Gate list (top-N Base tokens by market cap):
 *   - Fresh Redis cache (< 6h): applies it instantly, no network call.
 *   - Stale / missing cache: attempts a live fetch. On failure, falls back to
 *     EMERGENCY_SEED_ASSETS (WETH + USDC only) so the gate is never empty —
 *     this is a resilience floor, not a ranking override; the next successful
 *     refresh replaces it entirely with the real top-N list.
 *
 * Cosmetic label list: unchanged behavior — best-effort, never blocks
 * startup, falls back to gate-list-only labels on failure.
 *
 * Either way, schedules background refreshes for both lists.
 */
export async function initQuoteAssets(): Promise<void> {
  // ── Gate list ──────────────────────────────────────────────────────────
  const cachedGate = await loadRedisCache(GATE_CACHE_KEY);

  if (cachedGate && Date.now() - cachedGate.fetchedAt < CACHE_TTL_MS) {
    setGateAssets(cachedGate.tokens);
    const ageMin = Math.round((Date.now() - cachedGate.fetchedAt) / 60_000);
    console.log(`[quote-assets] Loaded gate list from cache — top ${gateAssetList.length} Base tokens (age: ${ageMin} min)`);
    const remaining = CACHE_TTL_MS - (Date.now() - cachedGate.fetchedAt);
    setTimeout(() => refreshGateAssets(), remaining);
  } else {
    console.log("[quote-assets] Gate cache missing or stale — fetching top Base tokens by market cap…");
    try {
      const tokens = await fetchTopBaseTokensByMarketCap();
      setGateAssets(tokens);
      await saveRedisCache(GATE_CACHE_KEY, tokens);
      console.log(`[quote-assets] Gate list fetched — top ${gateAssetList.length} Base tokens by market cap`);
    } catch (err) {
      console.warn(
        `[quote-assets] Gate fetch failed — falling back to emergency seed (WETH, USDC only) ` +
        `until the next refresh succeeds. Error: ${err instanceof Error ? err.message : err}`
      );
      setGateAssets(EMERGENCY_SEED_ASSETS.map((t) => ({ address: t.address, symbol: t.label })));
    }
    setTimeout(() => refreshGateAssets(), CACHE_TTL_MS);
  }

  // ── Cosmetic label list ────────────────────────────────────────────────
  const cachedLabels = await loadRedisCache(LABEL_CACHE_KEY);

  if (cachedLabels && Date.now() - cachedLabels.fetchedAt < CACHE_TTL_MS) {
    applyLabelList(cachedLabels.tokens);
    const ageMin = Math.round((Date.now() - cachedLabels.fetchedAt) / 60_000);
    console.log(`[quote-assets] Loaded ${quoteAssetMap.size} cosmetic labels from cache (age: ${ageMin} min)`);
    const remaining = CACHE_TTL_MS - (Date.now() - cachedLabels.fetchedAt);
    setTimeout(() => refreshLabels(), remaining);
    return;
  }

  console.log("[quote-assets] Label cache missing or stale — fetching from Coingecko…");
  try {
    const tokens = await fetchFromCoingecko();
    applyLabelList(tokens);
    await saveRedisCache(LABEL_CACHE_KEY, tokens);
    console.log(`[quote-assets] Fetched ${quoteAssetMap.size} cosmetic labels from Coingecko`);
  } catch (err) {
    console.warn(`[quote-assets] Cosmetic label fetch failed — continuing with gate-list labels only. Error: ${err instanceof Error ? err.message : err}`);
  }
  setTimeout(() => refreshLabels(), CACHE_TTL_MS);
}