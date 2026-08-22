'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { StoredAnalysis, RiskLevel } from './analysis/[id]/types';

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

const POLL_MS = 30_000;

export default function HomePage() {
  const [analyses, setAnalyses] = useState<StoredAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [lastPolled, setLastPolled] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch('/api/analysis');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const sorted: StoredAnalysis[] = (data.analyses || []).sort(
          (a: StoredAnalysis, b: StoredAnalysis) => b.timestamp - a.timestamp
        );
        setAnalyses(sorted);
        setLastPolled(new Date());
      } catch {
        // silent — the ticker just won't update this cycle
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const stats = useMemo(() => {
    const total = analyses.length;
    const critical = analyses.filter((a) => a.verdict === 'CRITICAL').length;
    const v4 = analyses.filter((a) => a.venue === 'v4').length;
    const v4Share = total > 0 ? Math.round((v4 / total) * 100) : 0;
    return { total, critical, v4Share };
  }, [analyses]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return analyses.slice(0, 8);
    return analyses
      .filter(
        (a) =>
          a.tokenName?.toLowerCase().includes(q) ||
          a.tokenSymbol?.toLowerCase().includes(q) ||
          a.tokenAddress?.toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [analyses, query]);

  return (
    <div className="min-h-screen bg-[#0B0C0E] text-[#EDEEF0] selection:bg-[#FF6B35]/30">
      <Nav totalScanned={stats.total} />
      <Hero total={stats.total} critical={stats.critical} />
      <CatchLog
        loading={loading}
        rows={filtered}
        query={query}
        onQueryChange={setQuery}
        lastPolled={lastPolled}
      />
      <StatsStrip total={stats.total} critical={stats.critical} v4Share={stats.v4Share} />
      <HowItWorks />
      <Footer />
    </div>
  );
}

// ─── Nav ────────────────────────────────────────────────────────────────────

function Nav({ totalScanned }: { totalScanned: number }) {
  return (
    <header className="sticky top-0 z-20 border-b border-[#24272C] bg-[#0B0C0E]/90 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <span
            className="font-[family-name:var(--font-display)] text-xl font-black tracking-tight"
            style={{ letterSpacing: '-0.02em' }}
          >
            ORION
          </span>
          <span className="hidden items-center gap-1.5 rounded-full border border-[#24272C] px-2.5 py-1 text-[10px] font-mono uppercase tracking-widest text-[#8B9198] sm:flex">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-[#FF6B35]" />
            scanning base · {totalScanned} logged
          </span>
        </div>
        <Link
          href="/analysis"
          className="rounded-full border border-[#24272C] px-4 py-1.5 text-sm text-[#EDEEF0] transition-colors hover:border-[#FF6B35]/50 hover:text-[#FF6B35]"
        >
          Full log →
        </Link>
      </div>
    </header>
  );
}

// ─── Hero ───────────────────────────────────────────────────────────────────

function Hero({ total, critical }: { total: number; critical: number }) {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-16 pt-16 sm:pt-24">
      <p className="mb-5 font-mono text-xs uppercase tracking-[0.2em] text-[#FF6B35]">
        Base Mainnet · Uniswap V3 &amp; V4
      </p>
      <h1
        className="font-[family-name:var(--font-display)] font-black leading-[0.92] tracking-tight"
        style={{ fontSize: 'clamp(2.75rem, 7vw, 6.25rem)', letterSpacing: '-0.02em' }}
      >
        ORION HUNTS
        <br />
        RUGS ON BASE
        <br />
        <span className="text-[#FF6B35]">BEFORE YOU BUY THEM.</span>
      </h1>
      <p className="mt-8 max-w-xl text-lg leading-relaxed text-[#8B9198]">
        Every new pool on Base gets read the moment it&apos;s created. An LLM agent pulls the
        deployer&apos;s history, checks whether liquidity is locked, and simulates a real sell —
        then posts a verdict, usually before the pool has its first trade.
      </p>
      <div className="mt-9 flex flex-wrap items-center gap-4">
        <Link
          href="/analysis"
          className="rounded-lg bg-[#FF6B35] px-6 py-3 text-sm font-semibold text-[#0B0C0E] transition-transform hover:scale-[1.02] active:scale-[0.98]"
        >
          See the live catch log
        </Link>
        <a
          href="#how-it-works"
          className="text-sm text-[#8B9198] underline decoration-[#24272C] underline-offset-4 transition-colors hover:text-[#EDEEF0]"
        >
          How the hunt works
        </a>
      </div>
      {total > 0 && (
        <p className="mt-10 font-mono text-xs text-[#8B9198]">
          <span className="text-[#EDEEF0]">{total}</span> pools scored so far ·{' '}
          <span className="text-red-400">{critical}</span> came back CRITICAL
        </p>
      )}
    </section>
  );
}

// ─── Live catch log ─────────────────────────────────────────────────────────

function CatchLog({
  loading,
  rows,
  query,
  onQueryChange,
  lastPolled,
}: {
  loading: boolean;
  rows: StoredAnalysis[];
  query: string;
  onQueryChange: (v: string) => void;
  lastPolled: Date | null;
}) {
  return (
    <section className="border-y border-[#24272C] bg-[#0E1012]">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-[family-name:var(--font-display)] text-2xl font-bold tracking-tight sm:text-3xl">
              Recent catches
            </h2>
            <p className="mt-1 text-sm text-[#8B9198]">
              {lastPolled
                ? `Live — last checked ${lastPolled.toLocaleTimeString()}, refreshes every 30s` 
                : 'Connecting…'}
            </p>
          </div>
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Filter by name, symbol or address"
            className="w-full max-w-xs rounded-lg border border-[#24272C] bg-[#131519] px-3.5 py-2 text-sm text-[#EDEEF0] placeholder:text-[#5C6167] outline-none focus:border-[#FF6B35]/50"
          />
        </div>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg border border-[#24272C] bg-[#131519]" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyLog hasQuery={query.trim().length > 0} />
        ) : (
          <div className="divide-y divide-[#1A1D21] overflow-hidden rounded-lg border border-[#24272C]">
            {rows.map((a) => (
              <CatchRow key={a.id} analysis={a} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function EmptyLog({ hasQuery }: { hasQuery: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-[#24272C] px-6 py-14 text-center">
      <p className="text-[#8B9198]">
        {hasQuery
          ? "No catches match that filter — try a different name, symbol, or address."
          : "No catches logged yet. Orion posts here the moment it scores a new pool."}
      </p>
    </div>
  );
}

function CatchRow({ analysis }: { analysis: StoredAnalysis }) {
  const verdict = (analysis.verdict as RiskLevel) in SEVERITY_TEXT ? (analysis.verdict as RiskLevel) : 'MEDIUM';
  return (
    <Link
      href={`/analysis/${analysis.id}`}
      className="row-in flex items-center gap-4 bg-[#131519] px-5 py-4 transition-colors hover:bg-[#181B1F]"
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
      <span className="hidden flex-shrink-0 font-mono text-xs text-[#5C6167] sm:block">
        {timeAgo(analysis.timestamp)}
      </span>
    </Link>
  );
}

function timeAgo(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ─── Stats strip ────────────────────────────────────────────────────────────

function StatsStrip({ total, critical, v4Share }: { total: number; critical: number; v4Share: number }) {
  const stats = [
    { label: 'Pools scanned', value: total.toLocaleString() },
    { label: 'Critical catches', value: critical.toLocaleString() },
    { label: 'On Uniswap V4', value: total > 0 ? `${v4Share}%` : '—' },
  ];
  return (
    <section className="mx-auto max-w-6xl px-6 py-14">
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-[#24272C] bg-[#24272C] sm:grid-cols-3">
        {stats.map((s) => (
          <div key={s.label} className="bg-[#0B0C0E] px-6 py-8">
            <p
              className="font-[family-name:var(--font-display)] font-black tabular-nums"
              style={{ fontSize: 'clamp(2rem, 4vw, 3rem)' }}
            >
              {s.value}
            </p>
            <p className="mt-1 text-sm text-[#8B9198]">{s.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── How it works ───────────────────────────────────────────────────────────

const STEPS = [
  {
    n: '01',
    title: 'Detect',
    body: "Every PoolCreated event on Uniswap V3 and every Initialize event on V4's singleton pool manager gets picked up within one scan interval.",
  },
  {
    n: '02',
    title: 'Collect evidence',
    body: 'The agent pulls deployer history, holder distribution, LP-lock status, verified source code, and runs a live sell simulation against the pool.',
  },
  {
    n: '03',
    title: 'Score',
    body: "That evidence goes to an LLM, which weighs it against known rug patterns — honeypots, unlocked liquidity, serial deployers — and returns a 0–100 risk score.",
  },
  {
    n: '04',
    title: 'Alert',
    body: 'A verdict from LOW to CRITICAL posts live, and a full evidence report goes up here — the same data the model saw, not just its conclusion.',
  },
];

function HowItWorks() {
  return (
    <section id="how-it-works" className="border-t border-[#24272C]">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="font-[family-name:var(--font-display)] text-2xl font-bold tracking-tight sm:text-3xl">
          How the hunt works
        </h2>
        <div className="mt-10 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step) => (
            <div key={step.n}>
              <span className="font-[family-name:var(--font-display)] text-3xl font-black text-[#FF6B35]">
                {step.n}
              </span>
              <h3 className="mt-3 text-lg font-semibold text-[#EDEEF0]">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[#8B9198]">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Footer ─────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t border-[#24272C]">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <span className="font-[family-name:var(--font-display)] text-lg font-black tracking-tight">
              ORION
            </span>
            <p className="mt-1 text-sm text-[#8B9198]">A hunting dog for Base liquidity pools.</p>
          </div>
          <div className="flex flex-col gap-1.5 font-mono text-xs text-[#5C6167] sm:text-right">
            <span>Watching every pool on:</span>
            <a
              href="https://basescan.org/address/0x33128a8fC17869897dcE68Ed026d694621f6FDfD"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#8B9198]"
            >
              Uniswap V3 Factory — 0x3312…6FDf
            </a>
            <a
              href="https://basescan.org/address/0x498581fF718922c3f8e6A244956aF099B2652b2b"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#8B9198]"
            >
              Uniswap V4 PoolManager — 0x4985…52b2
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
