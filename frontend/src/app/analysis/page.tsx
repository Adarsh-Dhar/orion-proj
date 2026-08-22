'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { StoredAnalysis, RiskLevel } from './[id]/types';

const severityColors: Record<RiskLevel, string> = {
  LOW: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  MEDIUM: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  HIGH: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  CRITICAL: 'bg-red-500/10 text-red-400 border-red-500/20',
};

const severityBorders: Record<RiskLevel, string> = {
  LOW: 'border-emerald-500/30',
  MEDIUM: 'border-amber-500/30',
  HIGH: 'border-orange-500/30',
  CRITICAL: 'border-red-500/30',
};

export default function AnalysesListPage() {
  const [analyses, setAnalyses] = useState<StoredAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RiskLevel | 'ALL'>('ALL');

  useEffect(() => {
    async function fetchAnalyses() {
      try {
        const response = await fetch('/api/analysis');
        if (!response.ok) throw new Error('Failed to fetch analyses');
        const data = await response.json();
        setAnalyses(data.analyses || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load analyses');
      } finally {
        setLoading(false);
      }
    }
    fetchAnalyses();
  }, []);

  const filteredAnalyses = filter === 'ALL' 
    ? analyses 
    : analyses.filter(a => a.verdict === filter);

  const stats = {
    total: analyses.length,
    low: analyses.filter(a => a.verdict === 'LOW').length,
    medium: analyses.filter(a => a.verdict === 'MEDIUM').length,
    high: analyses.filter(a => a.verdict === 'HIGH').length,
    critical: analyses.filter(a => a.verdict === 'CRITICAL').length,
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-sky-500 mx-auto mb-4" />
          <p className="text-zinc-400 text-sm">Loading analyses…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold mb-4">Error</h1>
          <p className="text-zinc-400">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="mx-auto max-w-6xl px-6 py-10 space-y-8">
        {/* Header */}
        <div>
          <p className="text-xs uppercase tracking-widest text-sky-500 font-mono mb-1">Orion // Analysis Dashboard</p>
          <h1 className="text-3xl font-bold tracking-tight">Token Analyses</h1>
          <p className="text-zinc-500 text-sm mt-2">
            {stats.total} total analyses performed
          </p>
        </div>

        {/* Stats Overview */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label="Total" value={stats.total} tone="neutral" />
          <StatCard label="Low Risk" value={stats.low} tone="good" />
          <StatCard label="Medium" value={stats.medium} tone="warn" />
          <StatCard label="High Risk" value={stats.high} tone="bad" />
          <StatCard label="Critical" value={stats.critical} tone="critical" />
        </div>

        {/* Filter Tabs */}
        <div className="flex flex-wrap gap-2">
          <FilterButton 
            active={filter === 'ALL'} 
            onClick={() => setFilter('ALL')}
            label="All"
            count={stats.total}
          />
          <FilterButton 
            active={filter === 'LOW'} 
            onClick={() => setFilter('LOW')}
            label="Low"
            count={stats.low}
            tone="LOW"
          />
          <FilterButton 
            active={filter === 'MEDIUM'} 
            onClick={() => setFilter('MEDIUM')}
            label="Medium"
            count={stats.medium}
            tone="MEDIUM"
          />
          <FilterButton 
            active={filter === 'HIGH'} 
            onClick={() => setFilter('HIGH')}
            label="High"
            count={stats.high}
            tone="HIGH"
          />
          <FilterButton 
            active={filter === 'CRITICAL'} 
            onClick={() => setFilter('CRITICAL')}
            label="Critical"
            count={stats.critical}
            tone="CRITICAL"
          />
        </div>

        {/* Analyses List */}
        {filteredAnalyses.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-8 text-center">
            <p className="text-zinc-500">No analyses found for the selected filter.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredAnalyses.map((analysis) => (
              <Link
                key={analysis.id}
                href={`/analysis/${analysis.id}`}
                className={`block rounded-lg border ${severityBorders[analysis.verdict as RiskLevel]} bg-zinc-900/40 p-5 hover:bg-zinc-800/60 transition-colors`}
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold">
                        {analysis.tokenName}{' '}
                        <span className="text-zinc-500 font-mono">${analysis.tokenSymbol}</span>
                      </h3>
                      <span className={`px-2 py-0.5 rounded text-xs font-medium border ${severityColors[analysis.verdict as RiskLevel]}`}>
                        {analysis.verdict}
                      </span>
                      {analysis.venue && (
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-zinc-800 text-zinc-400 border border-zinc-700">
                          {analysis.venue.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-zinc-400 line-clamp-2">{analysis.summary}</p>
                    <div className="flex flex-wrap gap-4 mt-3 text-xs font-mono text-zinc-500">
                      <span>Score: {analysis.score}</span>
                      <span>Flags: {analysis.flags.length}</span>
                      <span>
                        {new Date(analysis.timestamp).toLocaleDateString()} {new Date(analysis.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>
                  <div className="text-zinc-500">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: 'good' | 'warn' | 'bad' | 'critical' | 'neutral' }) {
  const toneColors = {
    good: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5',
    warn: 'text-amber-400 border-amber-500/30 bg-amber-500/5',
    bad: 'text-orange-400 border-orange-500/30 bg-orange-500/5',
    critical: 'text-red-400 border-red-500/30 bg-red-500/5',
    neutral: 'text-zinc-400 border-zinc-500/30 bg-zinc-500/5',
  };

  return (
    <div className={`rounded-lg border ${toneColors[tone]} px-4 py-3`}>
      <p className="text-xs text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}

function FilterButton({ 
  active, 
  onClick, 
  label, 
  count, 
  tone 
}: { 
  active: boolean; 
  onClick: () => void; 
  label: string; 
  count: number; 
  tone?: RiskLevel;
}) {
  const baseClasses = "px-4 py-2 rounded-lg text-sm font-medium transition-colors border";
  const activeClasses = active 
    ? "bg-zinc-800 border-zinc-600 text-white" 
    : "bg-zinc-900/40 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-300";

  return (
    <button
      onClick={onClick}
      className={`${baseClasses} ${activeClasses}`}
    >
      {label} ({count})
    </button>
  );
}