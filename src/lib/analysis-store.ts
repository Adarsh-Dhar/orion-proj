/**
 * analysis-store.ts — Upstash Redis integration for storing analysis traces.
 *
 * Provides functions to store and retrieve complete analysis data including
 * evidence, tool call transcripts, and LLM results using Upstash Redis REST API.
 */

import { Redis } from "@upstash/redis";
import type { StoredAnalysis } from "./utils/interface.js";

// ─── Environment validation ─────────────────────────────────────────────────────

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

let redisClient: Redis | null = null;

/**
 * Initialize the Upstash Redis client if credentials are available.
 * Returns null if credentials are missing (graceful degradation).
 */
function getRedisClient(): Redis | null {
  if (redisClient) return redisClient;
  
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.warn("[analysis-store] Upstash credentials not set — analysis storage disabled");
    return null;
  }
  
  try {
    redisClient = new Redis({
      url: UPSTASH_URL,
      token: UPSTASH_TOKEN,
    });
    return redisClient;
  } catch (err) {
    console.error("[analysis-store] Failed to initialize Upstash client:", err);
    return null;
  }
}

// ─── Storage functions ─────────────────────────────────────────────────────────

/**
 * Generate a unique analysis ID based on timestamp and token address.
 */
function generateAnalysisId(tokenAddress: string): string {
  const timestamp = Date.now();
  const addressShort = tokenAddress.slice(2, 10); // Remove 0x prefix, take first 8 chars
  return `${timestamp}-${addressShort}`;
}

/**
 * Store complete analysis data in Upstash Redis.
 * Returns the analysis ID if successful, null otherwise.
 */
export async function storeAnalysis(data: Omit<StoredAnalysis, "id" | "timestamp">): Promise<string | null> {
  const client = getRedisClient();
  if (!client) return null;
  
  const analysisId = generateAnalysisId(data.tokenAddress);
  const timestamp = Date.now();
  
  const storedAnalysis: StoredAnalysis = {
    ...data,
    id: analysisId,
    timestamp,
  };
  
  try {
    // Store as a plain object — Upstash serialises to JSON automatically.
    // Previously we called JSON.stringify() here, which caused a double-parse
    // issue: the API route received a JSON-encoded string instead of an object.
    await client.set(`analysis:${analysisId}`, storedAnalysis, {
      ex: 2592000, // 30 days
    });
    
    // Reverse index: most recent analysis for this token address
    await client.set(`latest:${data.tokenAddress}`, analysisId, {
      ex: 2592000,
    });
    
    console.log(`[analysis-store] Stored analysis ${analysisId} for token ${data.tokenAddress}`);
    return analysisId;
  } catch (err) {
    console.error(`[analysis-store] Failed to store analysis ${analysisId}:`, err);
    return null;
  }
}

/**
 * Retrieve analysis data by ID from Upstash Redis.
 * Returns null if not found or on error.
 */
export async function getAnalysis(analysisId: string): Promise<StoredAnalysis | null> {
  const client = getRedisClient();
  if (!client) return null;
  
  try {
    const data = await client.get(`analysis:${analysisId}`);
    if (!data) return null;
    
    // New records: Upstash returns a plain object (auto-deserialized).
    // Old records: stored via JSON.stringify(), so Upstash returns a string.
    if (typeof data === 'string') {
      return JSON.parse(data) as StoredAnalysis;
    }
    return data as StoredAnalysis;
  } catch (err) {
    console.error(`[analysis-store] Failed to retrieve analysis ${analysisId}:`, err);
    return null;
  }
}

/**
 * Retrieve the most recent analysis for a token address.
 * Returns null if not found or on error.
 */
export async function getLatestAnalysis(tokenAddress: string): Promise<StoredAnalysis | null> {
  const client = getRedisClient();
  if (!client) return null;
  
  try {
    const analysisId = await client.get(`latest:${tokenAddress}`);
    if (!analysisId) return null;
    
    return getAnalysis(analysisId as string);
  } catch (err) {
    console.error(`[analysis-store] Failed to retrieve latest analysis for ${tokenAddress}:`, err);
    return null;
  }
}

/**
 * Retrieve all analysis IDs (for the list view).
 * Returns an array of analysis IDs, empty array if none found or on error.
 */
export async function getAllAnalysisIds(): Promise<string[]> {
  const client = getRedisClient();
  if (!client) return [];
  
  try {
    const keys = await client.keys("analysis:*");
    if (!keys) return [];
    
    // Extract analysis IDs from keys (remove "analysis:" prefix)
    return keys.map((key) => key.replace("analysis:", ""));
  } catch (err) {
    console.error("[analysis-store] Failed to retrieve analysis IDs:", err);
    return [];
  }
}

/**
 * Retrieve multiple analyses by their IDs.
 * Returns an array of StoredAnalysis objects (excluding any that failed to load).
 */
export async function getMultipleAnalyses(ids: string[]): Promise<StoredAnalysis[]> {
  const client = getRedisClient();
  if (!client) return [];
  
  try {
    const analyses: StoredAnalysis[] = [];
    
    for (const id of ids) {
      const analysis = await getAnalysis(id);
      if (analysis) {
        analyses.push(analysis);
      }
    }
    
    return analyses;
  } catch (err) {
    console.error("[analysis-store] Failed to retrieve multiple analyses:", err);
    return [];
  }
}

/**
 * Patch an existing stored analysis with updated fields.
 *
 * Only the keys present in `patch` are overwritten — everything else in the
 * stored record is preserved.  Used by the re-verification pass to update
 * LP-lock status and initial liquidity after the grace period has elapsed.
 *
 * Special key: if `patch.evidencePatch` is present (a plain object), its keys
 * are deep-merged into the stored record's `evidence` field rather than
 * replacing it wholesale.  This lets callers update individual evidence fields
 * without fetching the full evidence object first.
 *
 * Note: decisionTrace is persisted alongside toolCallTranscript so /analysis/:id
 * can render the stop/continue reasoning, not just tool I/O.
 *
 * Returns true if the record was found and updated, false otherwise.
 */
export async function updateAnalysis(
  analysisId: string,
  patch: Partial<Omit<StoredAnalysis, "id" | "timestamp">> & {
    /** Merged into stored evidence instead of replacing it. */
    evidencePatch?: Record<string, unknown>;
  }
): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  try {
    const existing = await getAnalysis(analysisId);
    if (!existing) {
      console.warn(`[analysis-store] updateAnalysis: record ${analysisId} not found`);
      return false;
    }

    // Pull out evidencePatch before spreading so it doesn't land on the top-level record
    const { evidencePatch, ...topLevelPatch } = patch as typeof patch & { evidencePatch?: Record<string, unknown> };

    const updated: StoredAnalysis = {
      ...existing,
      ...topLevelPatch,
      // Deep-merge evidence patch if provided
      ...(evidencePatch
        ? { evidence: { ...existing.evidence, ...evidencePatch } as typeof existing.evidence }
        : {}),
    };

    await client.set(`analysis:${analysisId}`, updated, {
      ex: 2592000, // reset 30-day TTL
    });

    const patchedKeys = [
      ...Object.keys(topLevelPatch),
      ...(evidencePatch ? [`evidence.{${Object.keys(evidencePatch).join(",")}}`] : []),
    ];
    console.log(`[analysis-store] Updated analysis ${analysisId} (fields: ${patchedKeys.join(", ")})`);
    return true;
  } catch (err) {
    console.error(`[analysis-store] Failed to update analysis ${analysisId}:`, err);
    return false;
  }
}
