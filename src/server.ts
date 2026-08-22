/**
 * server.ts — Simple Express API server for serving analysis data to the frontend.
 * 
 * This server provides REST API endpoints for the Next.js frontend to retrieve
 * analysis data stored in Upstash Redis.
 */

import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import {
  getAllAnalysisIds,
  getMultipleAnalyses,
  getAnalysis,
} from './lib/analysis-store.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get all analyses (for the list view)
app.get('/api/analyses', async (req: Request, res: Response) => {
  try {
    const ids = await getAllAnalysisIds();
    
    // Get the most recent 50 analyses to avoid overwhelming the frontend
    const recentIds = ids.slice(-50);
    const analyses = await getMultipleAnalyses(recentIds);
    
    // Sort by timestamp descending (most recent first)
    const sortedAnalyses = analyses.sort((a, b) => b.timestamp - a.timestamp);
    
    res.json({ analyses: sortedAnalyses });
  } catch (error) {
    console.error('Error fetching analyses:', error);
    res.status(500).json({ error: 'Failed to fetch analyses' });
  }
});

// Get a specific analysis by ID
app.get('/api/analyses/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const analysis = await getAnalysis(id);
    
    if (!analysis) {
      res.status(404).json({ error: 'Analysis not found' });
      return;
    }
    
    res.json(analysis);
  } catch (error) {
    console.error('Error fetching analysis:', error);
    res.status(500).json({ error: 'Failed to fetch analysis' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Backend API server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API endpoints: http://localhost:${PORT}/api/analyses`);
});
