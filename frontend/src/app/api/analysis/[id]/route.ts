import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const raw = await redis.get(`analysis:${id}`);

    if (!raw) {
      return NextResponse.json({ error: 'Analysis not found' }, { status: 404 });
    }

    // Old records were stored via JSON.stringify() so Upstash returns a plain
    // string.  New records are stored as objects so Upstash auto-deserializes
    // them.  Handle both.
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

    return NextResponse.json(data);
  } catch (error) {
    console.error('Failed to fetch analysis:', error);
    return NextResponse.json({ error: 'Failed to fetch analysis' }, { status: 500 });
  }
}
