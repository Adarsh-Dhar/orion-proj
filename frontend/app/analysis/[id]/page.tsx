'use client';

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { SiteHeader, SiteFooter } from '@/components/rughound-site';
import type { StoredAnalysis, VerdictLevel } from './types';
import {
  VERDICT_TONE,
  ScoreGauge,
  ScoreBreakdown,
  Panel,
  StatCard,
  VerifiedPill,
  VenueBadge,
  HookBadge,
  HolderBars,
  TradeFlowBar,
  MeterBar,
  AgentPipeline,
  shortenAddress,
  fmtPct,
} from './components';

export default function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [analysis, setAnalysis] = useState<StoredAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadAnalysis() {
      try {
        const res = await fetch(`/api/analysis/${id}`);
        if (!res.ok) throw new Error('Failed to load analysis');
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
      <div className="min-h-screen bg-background">
        <SiteHeader />
        <div className="flex flex-col items-center justify-center py-40">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading analysis…</p>
        </div>
        <SiteFooter />
      </div>
    );
  }

  if (error || !analysis) {
    return (
      <div className="min-h-screen bg-background">
        <SiteHeader />
        <div className="flex flex-col items-center justify-center py-40 text-center">
          <p className="text-destructive mb-4">{error || 'Analysis not found'}</p>
          <Link href="/analysis" className="inline-flex items-center gap-2 font-semibold text-primary hover:gap-3 transition-all">
            <ArrowLeft className="size-4" /> Back to log
          </Link>
        </div>
        <SiteFooter />
      </div>
    );
  }

  const verdict: VerdictLevel =
    (analysis.verdict as VerdictLevel) in VERDICT_TONE
      ? (analysis.verdict as VerdictLevel)
      : 'MEDIUM';
  const tone = VERDICT_TONE[verdict];
  const scoringFailed = verdict === 'UNKNOWN' || analysis.score < 0;
  const evidence = analysis.evidence;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      <main className="mx-auto max-w-6xl px-5 py-12 lg:px-8 space-y-6">

        {/* Breadcrumb */}
        <Link
          href="/analysis"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors"
        >
          <ArrowLeft className="size-3.5" /> Analysis log
        </Link>

        {/* Hero card */}
        <div className={`rounded-2xl border ${tone.border} ${tone.bg} p-6 flex flex-col md:flex-row items-start md:items-center gap-6`}>
          <ScoreGauge score={analysis.score} verdict={verdict} />
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-serif text-2xl md:text-3xl tracking-tight text-primary">
                {analysis.tokenName}{' '}
                <span className="text-muted-foreground font-sans text-xl font-normal">({analysis.tokenSymbol})</span>
              </h1>
              <span className={`rounded-full border ${tone.border} ${tone.bg} px-3 py-1 text-xs font-bold uppercase tracking-widest ${tone.text}`}>
                {verdict}
              </span>
              <VenueBadge venue={analysis.venue} />
              <HookBadge hookAddress={analysis.hookAddress} />
            </div>
            <p className="mt-3 text-base text-muted-foreground max-w-2xl">{analysis.summary}</p>
            {scoringFailed && (
              <p className="mt-2 text-sm text-muted-foreground">
                This analysis could not be scored — see the failure flag below. This is not a confirmed safe or risky result.
              </p>
            )}
          </div>
        </div>

        {/* Detail grid */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">

          {/* Token details */}
          <Panel title="Token Details" icon="🪙">
            <div className="space-y-2 text-sm">
              <Row label="Address">
                <span className="font-mono text-foreground" title={analysis.tokenAddress}>
                  {shortenAddress(analysis.tokenAddress, 6)}
                </span>
              </Row>
              <Row label="Pool Address">
                <span className="font-mono text-foreground" title={analysis.poolAddress}>
                  {shortenAddress(analysis.poolAddress, 6)}
                </span>
              </Row>
              <Row label="Venue">
                <span className="font-mono text-foreground">{analysis.venue?.toUpperCase() || 'Unknown'}</span>
              </Row>
              <Row label="Paired Asset">
                <span className="font-mono text-foreground">{analysis.pairedAsset}</span>
              </Row>
              {evidence && (
                <Row label="Total Supply">
                  <span className="font-mono text-foreground">{evidence.totalSupplyFormatted}</span>
                </Row>
              )}
            </div>
          </Panel>

          {/* Risk assessment */}
          <Panel title="Risk Assessment" icon="⚠️">
            <div className="space-y-2 text-sm">
              <Row label="Verdict">
                <span className={`font-semibold ${tone.text}`}>{verdict}</span>
              </Row>
              <Row label="Score">
                <span className="font-mono text-foreground">
                  {scoringFailed ? '—' : `${analysis.score.toFixed(2)} / 100`}
                </span>
              </Row>
              <Row label="Scoring Method">
                <span className="text-foreground">{analysis.scoringMethod}</span>
              </Row>
              <Row label="Analysis ID">
                <span className="font-mono text-foreground" title={analysis.id}>{analysis.id}</span>
              </Row>
            </div>
          </Panel>

          {/* Score breakdown */}
          {!scoringFailed && analysis.scoreBreakdown && analysis.scoreBreakdown.length > 0 && (
            <Panel title="Score Breakdown" icon="📊" className="lg:col-span-2">
              <ScoreBreakdown breakdown={analysis.scoreBreakdown} />
            </Panel>
          )}

          {/* Risk flags */}
          {analysis.flags && analysis.flags.length > 0 && (
            <Panel title="Risk Flags" icon="🚩" className="lg:col-span-2">
              <div className="space-y-3">
                {analysis.flags.map((flag) => (
                  <div key={flag.id} className={`rounded-xl border-l-4 pl-4 py-3 pr-4 ${VERDICT_TONE[flag.severity]?.bg ?? ''} ${VERDICT_TONE[flag.severity]?.border ?? ''}`}>
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-semibold ${VERDICT_TONE[flag.severity]?.text ?? ''}`}>
                        {flag.severity}
                      </span>
                      <span className="text-foreground font-medium">{flag.label}</span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{flag.detail}</p>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {/* Holder distribution */}
          {evidence && (
            <Panel title="Holder Distribution" icon="👥">
              <div className="mb-4 grid grid-cols-2 gap-3">
                <StatCard
                  label="Dev Wallet"
                  value={fmtPct(evidence.deployerPct)}
                  tone={evidence.deployerPct !== null && evidence.deployerPct > 50 ? 'bad' : 'neutral'}
                />
                <StatCard
                  label="Top-5 Holders"
                  value={fmtPct(evidence.top5HoldersPct)}
                  tone={evidence.top5HoldersPct !== null && evidence.top5HoldersPct > 60 ? 'bad' : 'neutral'}
                />
              </div>
              <HolderBars holders={evidence.top5Holders} deployerAddress={evidence.deployerAddress} />
            </Panel>
          )}

          {/* Trade activity */}
          {evidence && (
            <Panel title="Trade Activity" icon="🔁">
              <div className="mb-4">
                <TradeFlowBar buyCount={evidence.buyCount} sellCount={evidence.sellCount} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Unique Traders" value={String(evidence.uniqueTraders)} />
                <StatCard
                  label="Round-trip %"
                  value={fmtPct(evidence.roundTripTraderPct)}
                  tone={evidence.roundTripTraderPct !== null && evidence.roundTripTraderPct > 40 ? 'warn' : 'neutral'}
                />
                <StatCard
                  label="Top Trader Share"
                  value={`${evidence.topTraderSwapSharePct.toFixed(2)}%`}
                  tone={evidence.topTraderSwapSharePct > 50 ? 'bad' : 'neutral'}
                />
                <StatCard label="Total Swaps" value={String(evidence.totalSwaps)} />
              </div>
            </Panel>
          )}

          {/* Liquidity */}
          {evidence && (
            <Panel title="Liquidity" icon="💧">
              <div className="space-y-3">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground">Initial Liquidity</span>
                    <span className="font-mono text-foreground">
                      {evidence.initialLiquidityEth !== null
                        ? `${evidence.initialLiquidityEth.toFixed(4)} ETH`
                        : 'unverified'}
                    </span>
                  </div>
                  <MeterBar
                    pct={
                      evidence.initialLiquidityEth !== null
                        ? Math.min(100, (evidence.initialLiquidityEth / 1) * 100)
                        : 0
                    }
                    tone={
                      evidence.initialLiquidityEth !== null && evidence.initialLiquidityEth < 0.3
                        ? 'red'
                        : 'sky'
                    }
                  />
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">LP Position Status</span>
                  <VerifiedPill
                    state={
                      evidence.lpPositionStatus === 'burned' ||
                      evidence.lpPositionStatus === 'locked_uncx'
                        ? 'verified'
                        : evidence.lpPositionStatus === 'held_by_eoa'
                        ? 'flagged'
                        : 'unverified'
                    }
                  />
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Sell Test</span>
                  <VerifiedPill
                    state={
                      evidence.sellTestPassed === true
                        ? 'verified'
                        : evidence.sellTestPassed === false
                        ? 'flagged'
                        : 'unverified'
                    }
                  />
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Liquidity Ever Pulled</span>
                  <VerifiedPill state={evidence.liquidityEverPulled ? 'flagged' : 'verified'} />
                </div>
              </div>
            </Panel>
          )}

          {/* Agent trace */}
          {analysis.toolCallTranscript && analysis.toolCallTranscript.length > 0 && (
            <Panel title="Agent Investigation Trace" icon="🕵️" className="lg:col-span-2">
              <AgentPipeline transcript={analysis.toolCallTranscript} />
            </Panel>
          )}
        </div>

        {/* Back link */}
        <div className="pt-4">
          <Link
            href="/analysis"
            className="inline-flex items-center gap-2 font-semibold text-primary hover:gap-3 transition-all"
          >
            <ArrowLeft className="size-4" /> Back to full log
          </Link>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

// ─── Simple key/value row ────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
