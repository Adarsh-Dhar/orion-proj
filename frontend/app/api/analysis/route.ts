import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Call the backend API to get all analyses
    const backendUrl = 'http://localhost:3001';
    const response = await fetch(`${backendUrl}/api/analyses`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Backend responded with ${response.status}`);
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching analyses:', error);
    // Return empty array on error to avoid breaking the frontend
    return NextResponse.json({ analyses: [] });
  }
}
