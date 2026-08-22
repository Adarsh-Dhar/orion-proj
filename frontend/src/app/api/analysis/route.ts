import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function GET() {
  try {
    // Get all keys that match the analysis pattern
    const keys = await redis.keys('analysis:*');
    
    if (keys.length === 0) {
      return NextResponse.json({ analyses: [] });
    }

    // Fetch all analyses in parallel
    const analyses = await Promise.all(
      keys.map(async (key) => {
        const raw = await redis.get(key);
        if (!raw) return null;
        
        // Handle both string and object responses from Redis
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        
        // Extract the ID from the key (remove 'analysis:' prefix)
        const id = key.replace('analysis:', '');
        
        return {
          id,
          ...data
        };
      })
    );

    // Filter out nulls and sort by timestamp (newest first)
    const validAnalyses = analyses
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .sort((a, b) => b.timestamp - a.timestamp);

    return NextResponse.json({ analyses: validAnalyses });
  } catch (error) {
    console.error('Failed to fetch analyses:', error);
    return NextResponse.json({ error: 'Failed to fetch analyses' }, { status: 500 });
  }
}