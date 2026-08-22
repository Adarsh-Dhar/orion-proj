'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { StoredAnalysis, RiskLevel } from './[id]/types';

const SEVERITY_DOT: Record<RiskLevel, string> = {
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

export default function AnalysisListPage() {
  const [analyses, setAnalyses] = useState<StoredAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    async function loadAnalyses() {
      try {
        const res = await fetch('/api/analysis');
        if (!res.ok) return;
        const data = await res.json();
        const sorted: StoredAnalysis[] = (data.analyses || []).sort(
          (a: StoredAnalysis, b: StoredAnalysis) => b.timestamp - a.timestamp
        );
        setAnalyses(sorted);
      } catch (error) {
        console.error('Failed to load analyses:', error);
      } finally {
        setLoading(false);
      }
    }

    loadAnalyses();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return analyses;
    return analyses.filter(
      (a) =>
        a.tokenName?.toLowerCase().includes(q) ||
        a.tokenSymbol?.toLowerCase().includes(q) ||
        a.tokenAddress?.toLowerCase().includes(q)
    );
  }, [analyses, query]);

  return (
    <div className="min-h-screen bg-[#0B0C0E] text-[#EDEEF0]">
      <header className="sticky top-0 z-20 border-b border-[#24272C] bg-[#0B0C0E]/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="font-[family-name:var(--font-display)] text-xl font-black tracking-tight">
            ORION
          </Link>
          <span className="text-sm text-[#8B9198]">{analyses.length} analyses logged</span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-6">
          <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight">
            Analysis Log
          </h1>
          <p className="mt-2 text-[#8B9198]">
            Complete history of pool analyses and risk assessments
          </p>
        </div>

        <div className="mb-6">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name, symbol or address"
            className="w-full max-w-md rounded-lg border border-[#24272C] bg-[#131519] px-4 py-2 text-sm text-[#EDEEF0] placeholder:text-[#5C6167] outline-none focus:border-[#FF6B35]/50"
          />
        </div>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg border border-[#24272C] bg-[#131519]" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#24272C] px-6 py-14 text-center">
            <p className="text-[#8B9198]">
              {query.trim().length > 0
                ? "No analyses match that filter."
                : "No analyses logged yet."}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#1A1D21] overflow-hidden rounded-lg border border-[#24272C]">
            {filtered.map((a) => (
              <AnalysisRow key={a.id} analysis={a} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function AnalysisRow({ analysis }: { analysis: StoredAnalysis }) {
  const verdict = (analysis.verdict as RiskLevel) in SEVERITY_TEXT ? (analysis.verdict as RiskLevel) : 'MEDIUM';
  
  return (
    <Link
      href={`/analysis/${analysis.id}`}
      className="flex items-center gap-4 bg-[#131519] px-5 py-4 transition-colors hover:bg-[#181B1F]"
    >
      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${SEVERITY_DOT[verdict]}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-[#EDEEF0]">{analysis.tokenName}</span>
          <span className="flex-shrink-0 font-mono text-xs text-[#5C6167]">${analysis.tokenSymbol}</span>
          {analysis.venue && (
            <span className="flex-shrink-0 rounded border border-[#24272C] px-1.5 py-0.5 font-mono text-[10px] uppercase text-[#8B9198]">
              {analysis.venue}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-sm text-[#8B9198]">{analysis.summary}</p>
      </div>
      <span className={`flex-shrink-0 font-mono text-sm font-semibold ${SEVERITY_TEXT[verdict]}`}>
        {analysis.score}
      </span>
      <span className="flex-shrink-0 font-mono text-xs text-[#5C6167]">
        {new Date(analysis.timestamp).toLocaleDateString()}
      </span>
    </Link>
  );
}
