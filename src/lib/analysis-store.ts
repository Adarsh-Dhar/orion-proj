/**
 * analysis-store.ts — Upstash Redis integration for storing analysis traces.
 *
 * Provides functions to store and retrieve complete analysis data including
 * evidence, tool call transcripts, and LLM results using Upstash Redis REST API.
 */

import { Redis } from "@upstash/redis";
import type { TokenEvidence } from "./evidence.js";
import type { ToolCallRecord, RiskFlag } from "./rugcheck-types.js";

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

// ─── Data structures ───────────────────────────────────────────────────────────

export interface StoredAnalysis {
  id: string;
  timestamp: number;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  poolAddress: string;
  pairedAsset: string;
  score: number;
  verdict: string;
  summary: string;
  evidence: TokenEvidence;
  toolCallTranscript?: ToolCallRecord[];
  flags: RiskFlag[];
  scoringMethod: string;
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
    // Store with TTL of 30 days (2592000 seconds)
    await client.set(`analysis:${analysisId}`, JSON.stringify(storedAnalysis), {
      ex: 2592000,
    });
    
    // Also store a reverse index by token address (most recent analysis)
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
    
    // Upstash may return an object if it deserialized automatically
    if (typeof data === 'object') {
      return data as StoredAnalysis;
    }
    
    return JSON.parse(data as string) as StoredAnalysis;
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
