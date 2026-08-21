'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import type { StoredAnalysis, RiskLevel } from './types';
import {
  ScoreGauge,
  Panel,
  StatCard,
  VerifiedPill,
  HolderBars,
  TradeFlowBar,
  MeterBar,
  AgentPipeline,
  VERDICT_TONE,
  shortenAddress,
  fmtPct,
} from './components';

const severityColors: Record<RiskLevel, string> = {
  LOW: 'text-emerald-400',
  MEDIUM: 'text-amber-400',
  HIGH: 'text-orange-400',
  CRITICAL: 'text-red-400',
};

const severityBorder: Record<RiskLevel, string> = {
  LOW: 'border-emerald-500',
  MEDIUM: 'border-amber-500',
  HIGH: 'border-orange-500',
  CRITICAL: 'border-red-500',
};

export default function AnalysisPage() {
  const params = useParams();
  const analysisId = params.id as string;
  const [analysis, setAnalysis] = useState<StoredAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warningsOpen, setWarningsOpen] = useState(false);

  useEffect(() => {
    async function fetchAnalysis() {
      try {
        const response = await fetch(`/api/analysis/${analysisId}`);
        if (!response.ok) throw new Error('Analysis not found');
        const data = await response.json();
        setAnalysis(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load analysis');
      } finally {
        setLoading(false);
      }
    }
    if (analysisId) fetchAnalysis();
  }, [analysisId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-sky-500 mx-auto mb-4" />
          <p className="text-zinc-400 text-sm">Loading analysis…</p>
        </div>
      </div>
    );
  }

  if (error || !analysis) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold mb-4">Analysis Not Found</h1>
          <p className="text-zinc-400">{error || 'This analysis does not exist or has expired.'}</p>
        </div>
      </div>
    );
  }

  const verdict = (analysis.verdict as RiskLevel) in VERDICT_TONE ? (analysis.verdict as RiskLevel) : 'MEDIUM';
  const tone = VERDICT_TONE[verdict];
  const ev = analysis.evidence;
  const sortedFlags = [...analysis.flags].sort((a, b) => {
    const order: RiskLevel[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    return order.indexOf(a.severity) - order.indexOf(b.severity);
  });

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="mx-auto max-w-6xl px-6 py-10 space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-sky-500 font-mono mb-1">Orion // Token Report</p>
            <h1 className="text-3xl font-bold tracking-tight">
              {analysis.tokenName}{' '}
              <span className="text-zinc-500 font-mono text-2xl">${analysis.tokenSymbol}</span>
            </h1>
            <p className="text-zinc-500 text-xs font-mono mt-1">
              {analysis.id} · {new Date(analysis.timestamp).toLocaleString()} · scored via{' '}
              <span className="text-zinc-400">{analysis.scoringMethod}</span>
            </p>
          </div>
          <a
            href={`https://basescan.org/address/${analysis.tokenAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-600 hover:text-white transition-colors"
          >
            View on BaseScan ↗
          </a>
        </div>

        {/* Hero: score + verdict + summary */}
        <div className={`rounded-2xl border ${tone.border} ${tone.bg} ${tone.glow} p-6 md:p-8`}>
          <div className="flex flex-col md:flex-row items-center gap-8">
            <ScoreGauge score={analysis.score} verdict={verdict} />
            <div className="flex-1 text-center md:text-left">
              <span className={`inline-block rounded-full border ${tone.border} px-3 py-1 text-xs font-bold uppercase tracking-widest ${tone.text}`}>
                {verdict} risk
              </span>
              <p className="mt-3 text-lg leading-relaxed text-zinc-200">{analysis.summary}</p>
              <div className="mt-4 flex flex-wrap justify-center md:justify-start gap-x-6 gap-y-1 text-xs font-mono text-zinc-400">
                <span>Token: {shortenAddress(analysis.tokenAddress, 6)}</span>
                <span>Pool: {shortenAddress(analysis.poolAddress, 6)}</span>
                <span>Paired: {analysis.pairedAsset}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Quick stat strip */}
        {ev && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Liquidity"
              value={ev.initialLiquidityEth != null ? `${ev.initialLiquidityEth.toFixed(3)} ETH` : 'Unverified'}
              tone={ev.liquidityLocked ? 'good' : 'warn'}
              sub={ev.liquidityLocked == null ? undefined : ev.liquidityLocked ? 'Pool active' : 'Empty pool'}
            />
            <StatCard
              label="Top 5 Holders"
              value={fmtPct(ev.top5HoldersPct)}
              tone={ev.top5HoldersPct !== null && ev.top5HoldersPct > 50 ? 'bad' : 'neutral'}
              sub={ev.holderScanPartial ? 'partial scan' : undefined}
            />
            <StatCard
              label="Deployer Holds"
              value={fmtPct(ev.deployerPct)}
              tone={ev.deployerPct !== null && ev.deployerPct > 10 ? 'warn' : 'neutral'}
            />
            <StatCard label="Total Swaps" value={ev.totalSwaps != null ? String(ev.totalSwaps) : '—'} sub={ev.uniqueTraders != null ? `${ev.uniqueTraders} unique traders` : undefined} />
          </div>
        )}

        {!ev && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
            Raw evidence was not stored for this analysis (legacy record) — showing summary data only.
          </div>
        )}

        {/* Two-column detail panels */}
        {ev && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Contract & Ownership */}
            <Panel title="Contract & Ownership" icon="🏛️">
              <dl className="space-y-3 text-sm">
                <Row label="Owner">
                  <span className="font-mono text-zinc-300">{shortenAddress(ev.ownerAddress ?? null)}</span>
                </Row>
                <Row label="Ownership renounced">
                  <VerifiedPill state={ev.ownershipRenounced === null ? 'unverified' : ev.ownershipRenounced ? 'verified' : 'flagged'} />
                </Row>
                <Row label="Proxy contract">
                  <VerifiedPill state={ev.isProxy === null ? 'unverified' : ev.isProxy ? 'flagged' : 'verified'} />
                </Row>
                <Row label="Source verified">
                  <VerifiedPill state={ev.sourceVerified === null ? 'unverified' : ev.sourceVerified ? 'verified' : 'flagged'} />
                </Row>
                <Row label="Secondary admin">
                  <VerifiedPill state={ev.secondaryAdminDetected ? 'flagged' : 'verified'} />
                </Row>
                {ev.suspiciousFunctions?.length > 0 && (
                  <div>
                    <p className="text-zinc-500 text-xs mb-1.5">Suspicious functions found</p>
                    <div className="space-y-1.5">
                      {ev.suspiciousFunctions.map((f, i) => (
                        <div key={i} className="rounded bg-red-500/10 border border-red-500/20 px-2.5 py-1.5">
                          <p className="text-xs font-mono text-red-400">{f.name}</p>
                          <p className="text-[11px] font-mono text-zinc-500 truncate">{f.snippet}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </dl>
            </Panel>

            {/* Liquidity & LP Lock */}
            <Panel title="Liquidity & LP Lock" icon="💧">
              <dl className="space-y-3 text-sm">
                <Row label="Pool liquidity">
                  <VerifiedPill state={ev.liquidityLocked === null ? 'unverified' : ev.liquidityLocked ? 'verified' : 'flagged'} />
                </Row>
                <Row label="LP position status">
                  <span className="font-mono text-xs uppercase text-zinc-300">{ev.lpPositionStatus?.replace(/_/g, ' ') ?? 'Unknown'}</span>
                </Row>
                <Row label="Liquidity ever pulled">
                  <VerifiedPill state={ev.liquidityEverPulled ? 'flagged' : 'verified'} />
                </Row>
                <Row label="Burn events">
                  <span className="font-mono text-zinc-300">{ev.burnEventCount}</span>
                </Row>
                {ev.liquidityDeltaPct != null && (
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-zinc-500">Liquidity change since last snapshot</span>
                      <span className={ev.liquidityDeltaPct < -20 ? 'text-red-400' : 'text-zinc-300'}>
                        {ev.liquidityDeltaPct > 0 ? '+' : ''}
                        {ev.liquidityDeltaPct.toFixed(1)}%
                        {ev.snapshotAgeMinutes != null ? ` · ${ev.snapshotAgeMinutes}m ago` : ''}
                      </span>
                    </div>
                    <MeterBar pct={Math.abs(ev.liquidityDeltaPct)} tone={ev.liquidityDeltaPct < -20 ? 'red' : 'sky'} />
                  </div>
                )}
              </dl>
            </Panel>

            {/* Holder Distribution */}
            <Panel title="Deployer & Holder Distribution" icon="👥">
              <div className="mb-4 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="text-zinc-500">Deployer</p>
                  <p className="font-mono text-zinc-300 mt-0.5">{shortenAddress(ev.deployerAddress)}</p>
                </div>
                <div>
                  <p className="text-zinc-500">Deployed before?</p>
                  <p className={`mt-0.5 font-mono ${ev.deployerSeenBefore ? 'text-amber-400' : 'text-emerald-400'}`}>
                    {ev.deployerSeenBefore ? `Yes · ${ev.deployerPriorTokens?.length ?? 0} prior token(s)` : 'First seen'}
                  </p>
                </div>
              </div>
              <HolderBars holders={ev.top5Holders ?? []} deployerAddress={ev.deployerAddress} />
              {ev.holderScanFailed && (
                <p className="mt-3 text-xs text-red-400">⚠ Holder scan failed — distribution is unverified.</p>
              )}
            </Panel>

            {/* Trade Activity */}
            <Panel title="Trade Activity" icon="📈">
              <TradeFlowBar buyCount={ev.buyCount ?? 0} sellCount={ev.sellCount ?? 0} />
              <div className="mt-4 grid grid-cols-2 gap-4 text-xs">
                <div>
                  <p className="text-zinc-500 mb-1">Round-trip traders</p>
                  <p className="font-mono text-zinc-300">
                    {ev.roundTripTraderCount ?? 0} ({fmtPct(ev.roundTripTraderPct)})
                  </p>
                </div>
                <div>
                  <p className="text-zinc-500 mb-1">Top trader swap share</p>
                  <p className={`font-mono ${ev.topTraderSwapSharePct > 50 ? 'text-red-400' : 'text-zinc-300'}`}>
                    {ev.topTraderSwapSharePct?.toFixed(1) ?? '—'}%
                  </p>
                  <div className="mt-1">
                    <MeterBar pct={ev.topTraderSwapSharePct ?? 0} tone={ev.topTraderSwapSharePct > 50 ? 'red' : 'orange'} />
                  </div>
                </div>
              </div>
              {ev.tradeScanPartial && <p className="mt-3 text-xs text-amber-400">⚠ Trade scan was partial — figures may be incomplete.</p>}
            </Panel>
          </div>
        )}

        {/* Honeypot test — full width strip */}
        {ev && (
          <Panel title="Honeypot / Sell Simulation" icon="🧪">
            <div className="flex flex-wrap items-center gap-6">
              <VerifiedPill state={ev.sellTestPassed === null ? 'unverified' : ev.sellTestPassed ? 'verified' : 'flagged'} />
              <p className="text-sm text-zinc-400">
                {ev.sellTestPassed === null && 'Sell simulation could not be run.'}
                {ev.sellTestPassed === true && 'A simulated sell from a real holder succeeded — no honeypot behavior detected.'}
                {ev.sellTestPassed === false && `Simulated sell failed${ev.sellTestError ? `: ${ev.sellTestError}` : '.'}`}
              </p>
              {ev.sellTestAmountSent && (
                <span className="ml-auto text-xs font-mono text-zinc-500">tested {ev.sellTestAmountSent} tokens</span>
              )}
            </div>
          </Panel>
        )}

        {/* Risk flags */}
        <Panel title="Risk Flags" icon="🚩" right={<span className="text-xs text-zinc-500 font-mono">{analysis.flags.length} raised</span>}>
          {sortedFlags.length === 0 ? (
            <p className="text-zinc-500 text-sm">No risk flags raised.</p>
          ) : (
            <div className="space-y-3">
              {sortedFlags.map((flag) => (
                <div key={flag.id} className={`border-l-4 ${severityBorder[flag.severity]} pl-4 py-0.5`}>
                  <div className="flex items-center justify-between gap-3">
                    <span className={`text-sm font-semibold ${severityColors[flag.severity]}`}>
                      [{flag.severity}] {flag.label}
                    </span>
                    <span className="text-zinc-500 text-xs font-mono flex-shrink-0">{flag.points} pts</span>
                  </div>
                  <p className="text-zinc-400 text-sm mt-0.5">{flag.detail}</p>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* Agent investigation pipeline */}
        {analysis.toolCallTranscript && analysis.toolCallTranscript.length > 0 && (
          <Panel
            title="Agent Investigation Pipeline"
            icon="🤖"
            right={<span className="text-xs text-zinc-500 font-mono">{analysis.toolCallTranscript.length} tool calls</span>}
          >
            <p className="text-sm text-zinc-500 mb-5">
              How the agent reached its verdict — each step below is a real on-chain lookup the model chose to make before scoring.
            </p>
            <AgentPipeline transcript={analysis.toolCallTranscript} />
          </Panel>
        )}

        {/* Data confidence / RPC warnings */}
        {ev && ev.rpcWarnings.length > 0 && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40">
            <button
              onClick={() => setWarningsOpen((o) => !o)}
              className="w-full flex items-center justify-between px-5 py-3.5 text-sm"
            >
              <span className="text-zinc-300 font-semibold">
                ⚠ Data confidence — {ev.rpcWarnings.length} field(s) unverified
              </span>
              <span className={`text-zinc-500 transition-transform ${warningsOpen ? 'rotate-180' : ''}`}>▾</span>
            </button>
            {warningsOpen && (
              <div className="px-5 pb-5 space-y-1.5">
                {ev.rpcWarnings.map((w, i) => (
                  <p key={i} className="text-xs font-mono text-amber-400/80">
                    {w}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="pt-4 text-center text-zinc-600 text-xs flex justify-center gap-6">
          <a
            href={`https://basescan.org/address/${analysis.tokenAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-zinc-300"
          >
            Token on BaseScan →
          </a>
          <a
            href={`https://basescan.org/address/${analysis.poolAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-zinc-300"
          >
            Pool on BaseScan →
          </a>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-zinc-500">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
