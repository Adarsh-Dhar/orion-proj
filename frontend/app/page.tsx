'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ShieldCheck, CircleCheck } from 'lucide-react';
import { SiteHeader, SiteFooter } from '@/components/rughound-site';
import type { StoredAnalysis, RiskLevel } from './analysis/[id]/types';

// ─── Risk severity mappings (light-theme tokens) ─────────────────────────────

const SEVERITY_DOT: Record<RiskLevel, string> = {
  LOW:      'bg-[var(--risk-low)]',
  MEDIUM:   'bg-[var(--risk-medium)]',
  HIGH:     'bg-[var(--risk-high)]',
  CRITICAL: 'bg-[var(--risk-critical)]',
};

const SEVERITY_TEXT: Record<RiskLevel, string> = {
  LOW:      'text-[var(--risk-low)]',
  MEDIUM:   'text-[var(--risk-medium)]',
  HIGH:     'text-[var(--risk-high)]',
  CRITICAL: 'text-[var(--risk-critical)]',
};

const SEVERITY_BADGE: Record<RiskLevel, string> = {
  LOW:      'bg-green-50 text-green-700 border-green-200',
  MEDIUM:   'bg-amber-50 text-amber-700 border-amber-200',
  HIGH:     'bg-orange-50 text-orange-700 border-orange-200',
  CRITICAL: 'bg-red-50 text-red-700 border-red-200',
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
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main>
        <Hero total={stats.total} critical={stats.critical} />
        <TrustBar />
        <CatchLog
          loading={loading}
          rows={filtered}
          query={query}
          onQueryChange={setQuery}
          lastPolled={lastPolled}
        />
        <StatsStrip total={stats.total} critical={stats.critical} v4Share={stats.v4Share} />
        <HowItWorks />
      </main>
      <SiteFooter />
    </div>
  );
}

// ─── Hero ────────────────────────────────────────────────────────────────────

function Hero({ total, critical }: { total: number; critical: number }) {
  return (
    <section className="relative overflow-hidden bg-primary px-5 py-20 text-primary-foreground lg:px-8 lg:py-28">
      <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1.05fr_.95fr]">
        <div>
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-primary-foreground/20 bg-primary-foreground/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground/80">
            <ShieldCheck className="size-4" /> Base Mainnet · Uniswap V3 &amp; V4
          </div>
          <h1 className="max-w-3xl font-serif text-5xl leading-[0.98] tracking-tight text-balance sm:text-6xl lg:text-7xl">
            Don&apos;t get rugged.
            <br />
            <span className="text-brand-tan">Get Rughound.</span>
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-8 text-primary-foreground/80">
            Every new pool on Base gets read the moment it&apos;s created. An agent pulls
            deployer history, checks whether liquidity is locked, simulates a real sell —
            and posts a verdict before the pool has its first trade.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link
              href="/analysis"
              className="inline-flex items-center gap-2 rounded-full bg-brand-tan px-5 py-3 font-semibold text-primary transition-transform hover:-translate-y-0.5"
            >
              See the live catch log <ArrowRight className="size-4" />
            </Link>
            <a
              href="#how-it-works"
              className="inline-flex items-center rounded-full border border-primary-foreground/25 px-5 py-3 font-semibold text-primary-foreground hover:bg-primary-foreground/10"
            >
              How the hunt works
            </a>
          </div>
          {total > 0 && (
            <p className="mt-10 font-mono text-xs text-primary-foreground/60">
              <span className="text-primary-foreground">{total.toLocaleString()}</span> pools scored so far ·{' '}
              <span className="text-brand-tan">{critical}</span> came back CRITICAL
            </p>
          )}
        </div>
        <div className="relative flex justify-center">
          <div className="absolute inset-12 rounded-full bg-brand-tan/15 blur-3xl" />
          <img
            src="/rughound-purple.png"
            alt="Rughound mascot"
            className="relative w-full max-w-md object-contain"
            style={{
              maskImage: 'radial-gradient(ellipse at center, black 58%, transparent 82%)',
              WebkitMaskImage: 'radial-gradient(ellipse at center, black 58%, transparent 82%)',
            }}
          />
        </div>
      </div>
    </section>
  );
}

// ─── Trust bar ───────────────────────────────────────────────────────────────

function TrustBar() {
  return (
    <section className="border-b border-border bg-brand-cream px-5 py-5 lg:px-8">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm font-semibold text-primary sm:justify-between">
        <span className="flex items-center gap-2"><CircleCheck className="size-4 text-brand-green" /> Scans every new Base pool</span>
        <span className="flex items-center gap-2"><CircleCheck className="size-4 text-brand-green" /> Honeypot sell simulation</span>
        <span className="flex items-center gap-2"><CircleCheck className="size-4 text-brand-green" /> LP lock &amp; deployer history</span>
      </div>
    </section>
  );
}

// ─── Live catch log ──────────────────────────────────────────────────────────

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
    <section className="bg-brand-cream/40 border-y border-border">
      <div className="mx-auto max-w-6xl px-5 py-14 lg:px-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Live feed</p>
            <h2 className="mt-2 font-serif text-3xl tracking-tight text-primary sm:text-4xl">
              Recent catches
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {lastPolled
                ? `Last checked ${lastPolled.toLocaleTimeString()} · refreshes every 30s`
                : 'Connecting…'}
            </p>
          </div>
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Filter by name, symbol or address"
            className="w-full max-w-xs rounded-xl border border-border bg-background px-3.5 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none ring-primary focus:ring-2"
          />
        </div>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl border border-border bg-background" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyLog hasQuery={query.trim().length > 0} />
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
            {rows.map((a) => (
              <CatchRow key={a.id} analysis={a} />
            ))}
          </div>
        )}

        {rows.length > 0 && (
          <div className="mt-6 text-center">
            <Link
              href="/analysis"
              className="inline-flex items-center gap-2 font-semibold text-primary hover:gap-3 transition-all"
            >
              View full log <ArrowRight className="size-4" />
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}

function EmptyLog({ hasQuery }: { hasQuery: boolean }) {
  return (
    <div className="rounded-2xl border border-dashed border-border px-6 py-14 text-center">
      <p className="text-muted-foreground">
        {hasQuery
          ? 'No catches match that filter — try a different name, symbol, or address.'
          : 'No catches logged yet. Rughound posts here the moment it scores a new pool.'}
      </p>
    </div>
  );
}

function CatchRow({ analysis }: { analysis: StoredAnalysis }) {
  const verdict = (analysis.verdict as RiskLevel) in SEVERITY_TEXT
    ? (analysis.verdict as RiskLevel)
    : 'MEDIUM';
  return (
    <Link
      href={`/analysis/${analysis.id}`}
      className="row-in flex items-center gap-4 px-5 py-4 transition-colors hover:bg-brand-cream/50"
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
      <span className={`flex-shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-xs font-semibold ${SEVERITY_BADGE[verdict]}`}>
        {verdict}
      </span>
      <span className="hidden flex-shrink-0 font-mono text-xs text-muted-foreground sm:block">
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

// ─── Stats strip ─────────────────────────────────────────────────────────────

function StatsStrip({ total, critical, v4Share }: { total: number; critical: number; v4Share: number }) {
  const items = [
    { label: 'Pools scanned', value: total.toLocaleString() },
    { label: 'Critical catches', value: critical.toLocaleString() },
    { label: 'On Uniswap V4', value: total > 0 ? `${v4Share}%` : '—' },
  ];
  return (
    <section className="mx-auto max-w-6xl px-5 py-14 lg:px-8">
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-3">
        {items.map((s) => (
          <div key={s.label} className="bg-background px-6 py-8">
            <p className="font-serif text-4xl font-normal text-primary tabular-nums sm:text-5xl">
              {s.value}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── How it works ─────────────────────────────────────────────────────────────

const STEPS = [
  {
    n: '01',
    title: 'Detect',
    body: 'Every PoolCreated event on Uniswap V3 and every Initialize event on V4\'s singleton pool manager gets picked up within one scan interval.',
  },
  {
    n: '02',
    title: 'Collect evidence',
    body: 'The agent pulls deployer history, holder distribution, LP-lock status, verified source code, and runs a live sell simulation against the pool.',
  },
  {
    n: '03',
    title: 'Score',
    body: 'That evidence goes to an LLM, which weighs it against known rug patterns — honeypots, unlocked liquidity, serial deployers — and returns a 0–100 risk score.',
  },
  {
    n: '04',
    title: 'Alert',
    body: 'A verdict from LOW to CRITICAL posts live, and a full evidence report goes up here — the same data the model saw, not just its conclusion.',
  },
];

function HowItWorks() {
  return (
    <section id="how-it-works" className="bg-brand-cream px-5 py-20 lg:px-8 lg:py-28">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl">
          <p className="eyebrow">How it works</p>
          <h2 className="section-title">Four steps between you and a bad buy.</h2>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step) => (
            <div key={step.n} className="rounded-2xl border border-border bg-background p-6">
              <span className="font-mono text-sm font-bold text-primary">{step.n}</span>
              <h3 className="mt-8 text-xl font-semibold text-primary">{step.title}</h3>
              <p className="mt-3 leading-7 text-muted-foreground">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
