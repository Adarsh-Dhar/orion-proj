'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  output: unknown;
  ts: number;
}

interface RiskFlag {
  id: string;
  label: string;
  detail: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  points: number;
}

interface StoredAnalysis {
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
  toolCallTranscript?: ToolCallRecord[];
  flags: RiskFlag[];
  scoringMethod: string;
}

export default function AnalysisPage() {
  const params = useParams();
  const analysisId = params.id as string;
  const [analysis, setAnalysis] = useState<StoredAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchAnalysis() {
      try {
        const response = await fetch(`/api/analysis/${analysisId}`);
        if (!response.ok) {
          throw new Error('Analysis not found');
        }
        const data = await response.json();
        setAnalysis(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load analysis');
      } finally {
        setLoading(false);
      }
    }

    if (analysisId) {
      fetchAnalysis();
    }
  }, [analysisId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
          <p>Loading analysis...</p>
        </div>
      </div>
    );
  }

  if (error || !analysis) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold mb-4">Analysis Not Found</h1>
          <p className="text-gray-400">{error || 'This analysis does not exist or has expired.'}</p>
        </div>
      </div>
    );
  }

  const verdictColors = {
    LOW: 'bg-green-500',
    MEDIUM: 'bg-yellow-500',
    HIGH: 'bg-orange-500',
    CRITICAL: 'bg-red-500',
  };

  const severityColors = {
    LOW: 'text-green-400',
    MEDIUM: 'text-yellow-400',
    HIGH: 'text-orange-400',
    CRITICAL: 'text-red-400',
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">
            {analysis.tokenName} ({analysis.tokenSymbol})
          </h1>
          <p className="text-gray-400 text-sm">
            Analysis ID: {analysis.id} • {new Date(analysis.timestamp).toLocaleString()}
          </p>
        </div>

        {/* Risk Score Card */}
        <div className={`${verdictColors[analysis.verdict as keyof typeof verdictColors]} rounded-lg p-6 mb-6`}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm uppercase tracking-wide opacity-80">Risk Score</p>
              <p className="text-4xl font-bold">{analysis.score}/100</p>
            </div>
            <div className="text-right">
              <p className="text-sm uppercase tracking-wide opacity-80">Verdict</p>
              <p className="text-2xl font-bold">{analysis.verdict}</p>
            </div>
          </div>
          <p className="mt-4 text-lg">{analysis.summary}</p>
        </div>

        {/* Token Details */}
        <div className="bg-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-bold mb-4">Token Details</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-gray-400 text-sm">Token Address</p>
              <p className="font-mono text-sm">{analysis.tokenAddress}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Pool Address</p>
              <p className="font-mono text-sm">{analysis.poolAddress}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Paired Asset</p>
              <p>{analysis.pairedAsset}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Scoring Method</p>
              <p>{analysis.scoringMethod}</p>
            </div>
          </div>
        </div>

        {/* Risk Flags */}
        <div className="bg-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-bold mb-4">Risk Flags</h2>
          {analysis.flags.length === 0 ? (
            <p className="text-gray-400">No risk flags raised</p>
          ) : (
            <div className="space-y-3">
              {analysis.flags.map((flag) => (
                <div key={flag.id} className="border-l-4 border-gray-600 pl-4">
                  <div className="flex items-center justify-between">
                    <span className={`font-semibold ${severityColors[flag.severity]}`}>
                      [{flag.severity}] {flag.label}
                    </span>
                    <span className="text-gray-400 text-sm">{flag.points} pts</span>
                  </div>
                  <p className="text-gray-300 text-sm mt-1">{flag.detail}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Tool Call Transcript */}
        {analysis.toolCallTranscript && analysis.toolCallTranscript.length > 0 && (
          <div className="bg-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-bold mb-4">Agent Investigation Trace</h2>
            <div className="space-y-4">
              {analysis.toolCallTranscript.map((call, index) => (
                <div key={index} className="border border-gray-700 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-blue-400">{call.name}</span>
                    <span className="text-gray-400 text-xs">
                      {new Date(call.ts).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-sm">
                    <p className="text-gray-400 mb-1">Arguments:</p>
                    <pre className="bg-gray-900 p-2 rounded text-xs overflow-x-auto">
                      {JSON.stringify(call.args, null, 2)}
                    </pre>
                    <p className="text-gray-400 mt-2 mb-1">Output:</p>
                    <pre className="bg-gray-900 p-2 rounded text-xs overflow-x-auto">
                      {JSON.stringify(call.output, null, 2).slice(0, 500)}
                      {JSON.stringify(call.output).length > 500 ? '...' : ''}
                    </pre>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="mt-8 text-center text-gray-400 text-sm">
          <a
            href={`https://basescan.org/address/${analysis.tokenAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white"
          >
            View on BaseScan →
          </a>
        </div>
      </div>
    </div>
  );
}
