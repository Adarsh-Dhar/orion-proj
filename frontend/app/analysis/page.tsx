'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { SiteHeader, SiteFooter } from '@/components/rughound-site';
import type { StoredAnalysis, VerdictLevel } from './[id]/types';

const SEVERITY_DOT: Record<VerdictLevel, string> = {
  LOW:      'bg-[var(--risk-low)]',
  MEDIUM:   'bg-[var(--risk-medium)]',
  HIGH:     'bg-[var(--risk-high)]',
  CRITICAL: 'bg-[var(--risk-critical)]',
  UNKNOWN:  'bg-muted-foreground',
};

const SEVERITY_TEXT: Record<VerdictLevel, string> = {
  LOW:      'text-[var(--risk-low)]',
  MEDIUM:   'text-[var(--risk-medium)]',
  HIGH:     'text-[var(--risk-high)]',
  CRITICAL: 'text-[var(--risk-critical)]',
  UNKNOWN:  'text-muted-foreground',
};

const SEVERITY_BADGE: Record<VerdictLevel, string> = {
  LOW:      'bg-green-50 text-green-700 border-green-200',
  MEDIUM:   'bg-amber-50 text-amber-700 border-amber-200',
  HIGH:     'bg-orange-50 text-orange-700 border-orange-200',
  CRITICAL: 'bg-red-50 text-red-700 border-red-200',
  UNKNOWN:  'bg-muted text-muted-foreground border-border',
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
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      <main className="mx-auto max-w-6xl px-5 py-14 lg:px-8">
        {/* Page header */}
        <div className="mb-8">
          <p className="eyebrow">Complete history</p>
          <h1 className="section-title max-w-2xl">Analysis log</h1>
          <p className="mt-4 text-muted-foreground">
            Every pool Rughound has scored, newest first.{' '}
            {analyses.length > 0 && (
              <span className="font-semibold text-primary">{analyses.length.toLocaleString()} analyses logged.</span>
            )}
          </p>
        </div>

        {/* Search */}
        <div className="mb-6">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name, symbol or address"
            className="w-full max-w-md rounded-xl border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none ring-primary focus:ring-2"
          />
        </div>

        {/* List */}
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl border border-border bg-brand-cream/40" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border px-6 py-14 text-center">
            <p className="text-muted-foreground">
              {query.trim().length > 0
                ? 'No analyses match that filter.'
                : 'No analyses logged yet.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
            {filtered.map((a) => (
              <AnalysisRow key={a.id} analysis={a} />
            ))}
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}

function AnalysisRow({ analysis }: { analysis: StoredAnalysis }) {
  const verdict = (analysis.verdict as VerdictLevel) in SEVERITY_TEXT
    ? (analysis.verdict as VerdictLevel)
    : 'MEDIUM';
  const scoringFailed = verdict === 'UNKNOWN' || analysis.score < 0;
  const date = new Date(analysis.timestamp);
  const dateStr = date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' });
  const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <Link
      href={`/analysis/${analysis.id}`}
      className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-brand-cream/50"
    >
      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${SEVERITY_DOT[verdict]}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-foreground">{analysis.tokenName}</span>
          <span className="flex-shrink-0 font-mono text-xs text-muted-foreground">${analysis.tokenSymbol}</span>
          {analysis.venue && (
            <span className="flex-shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
              {analysis.venue}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-sm text-muted-foreground">{analysis.summary}</p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-3">
        <span className={`hidden rounded-full border px-2.5 py-0.5 font-mono text-xs font-semibold sm:inline-block ${SEVERITY_BADGE[verdict]}`}>
          {verdict}
        </span>
        <span className={`font-mono text-sm font-semibold sm:hidden ${SEVERITY_TEXT[verdict]}`}>
          {scoringFailed ? '—' : analysis.score.toFixed(2)}
        </span>
      </div>
      <div className="flex-shrink-0 text-right">
        <div className="font-mono text-xs text-muted-foreground">{dateStr}</div>
        <div className="font-mono text-xs text-muted-foreground">{timeStr}</div>
      </div>
    </Link>
  );
}
