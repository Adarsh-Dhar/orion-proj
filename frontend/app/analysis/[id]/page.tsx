'use client';

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import type { StoredAnalysis, RiskLevel } from './types';

const SEVERITY_COLORS: Record<RiskLevel, string> = {
  LOW: 'bg-emerald-400',
  MEDIUM: 'bg-amber-400',
  HIGH: 'bg-orange-400',
  CRITICAL: 'bg-red-400',
};

const SEVERITY_TEXT: Record<RiskLevel, string> = {
  LOW: 'text-emerald-400',
  MEDIUM: 'text-amber-400',
  HIGH: 'text-orange-400',
  CRITICAL: 'text-red-400',
};

export default function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [analysis, setAnalysis] = useState<StoredAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadAnalysis() {
      try {
        const res = await fetch(`/api/analysis/${id}`);
        if (!res.ok) {
          throw new Error('Failed to load analysis');
        }
        const data = await res.json();
        setAnalysis(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    loadAnalysis();
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0B0C0E] text-[#EDEEF0] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35] mx-auto mb-4"></div>
          <p className="text-[#8B9198]">Loading analysis...</p>
        </div>
      </div>
    );
  }

  if (error || !analysis) {
    return (
      <div className="min-h-screen bg-[#0B0C0E] text-[#EDEEF0] flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">Error: {error || 'Analysis not found'}</p>
          <Link href="/" className="text-[#FF6B35] hover:underline">
            ← Back to home
          </Link>
        </div>
      </div>
    );
  }

  const verdict = (analysis.verdict as RiskLevel) in SEVERITY_TEXT ? (analysis.verdict as RiskLevel) : 'MEDIUM';

  return (
    <div className="min-h-screen bg-[#0B0C0E] text-[#EDEEF0]">
      <header className="sticky top-0 z-20 border-b border-[#24272C] bg-[#0B0C0E]/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="font-[family-name:var(--font-display)] text-xl font-black tracking-tight">
            ORION
          </Link>
          <Link
            href="/analysis"
            className="rounded-full border border-[#24272C] px-4 py-1.5 text-sm text-[#EDEEF0] transition-colors hover:border-[#FF6B35]/50 hover:text-[#FF6B35]"
          >
            Full log →
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-8">
          <Link href="/" className="text-sm text-[#8B9198] hover:text-[#EDEEF0] mb-4 inline-block">
            ← Back to home
          </Link>
          <div className="flex items-center gap-4 mt-4">
            <span className={`h-3 w-3 rounded-full ${SEVERITY_COLORS[verdict]}`} />
            <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight">
              {analysis.tokenName} ({analysis.tokenSymbol})
            </h1>
            <span className={`font-mono text-lg font-semibold ${SEVERITY_TEXT[verdict]}`}>
              {analysis.score}/100
            </span>
          </div>
          <p className="mt-2 text-lg text-[#8B9198]">{analysis.summary}</p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-lg border border-[#24272C] bg-[#131519] p-6">
            <h2 className="font-semibold text-[#EDEEF0] mb-4">Token Details</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-[#8B9198]">Address:</span>
                <span className="font-mono text-[#EDEEF0]">{analysis.tokenAddress}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8B9198]">Pool Address:</span>
                <span className="font-mono text-[#EDEEF0]">{analysis.poolAddress}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8B9198]">Venue:</span>
                <span className="font-mono text-[#EDEEF0]">{analysis.venue || 'Unknown'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8B9198]">Paired Asset:</span>
                <span className="font-mono text-[#EDEEF0]">{analysis.pairedAsset}</span>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-[#24272C] bg-[#131519] p-6">
            <h2 className="font-semibold text-[#EDEEF0] mb-4">Risk Assessment</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-[#8B9198]">Verdict:</span>
                <span className={`font-semibold ${SEVERITY_TEXT[verdict]}`}>{verdict}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8B9198]">Score:</span>
                <span className="font-mono text-[#EDEEF0]">{analysis.score}/100</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8B9198]">Scoring Method:</span>
                <span className="text-[#EDEEF0]">{analysis.scoringMethod}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8B9198]">Analysis ID:</span>
                <span className="font-mono text-[#EDEEF0]">{analysis.id}</span>
              </div>
            </div>
          </div>

          {analysis.flags && analysis.flags.length > 0 && (
            <div className="rounded-lg border border-[#24272C] bg-[#131519] p-6 lg:col-span-2">
              <h2 className="font-semibold text-[#EDEEF0] mb-4">Risk Flags</h2>
              <div className="space-y-3">
                {analysis.flags.map((flag) => (
                  <div key={flag.id} className="border-l-2 border-[#FF6B35] pl-4">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-semibold ${SEVERITY_TEXT[flag.severity]}`}>
                        {flag.severity}
                      </span>
                      <span className="text-[#EDEEF0]">{flag.label}</span>
                    </div>
                    <p className="mt-1 text-sm text-[#8B9198]">{flag.detail}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
