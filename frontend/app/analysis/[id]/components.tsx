'use client';

import { useState } from 'react';
import type { RiskLevel, VerdictLevel, ToolCallRecord } from './types';

// ─── Verdict tone tokens (light theme) ───────────────────────────────────────

export const VERDICT_TONE: Record<
  VerdictLevel,
  { ring: string; text: string; bg: string; border: string; glow: string }
> = {
  LOW:      { ring: '#16a34a', text: 'text-green-700',  bg: 'bg-green-50',  border: 'border-green-200',  glow: 'shadow-[0_0_40px_-10px_rgba(22,163,74,0.15)]'  },
  MEDIUM:   { ring: '#b45309', text: 'text-amber-700',  bg: 'bg-amber-50',  border: 'border-amber-200',  glow: 'shadow-[0_0_40px_-10px_rgba(180,83,9,0.12)]'   },
  HIGH:     { ring: '#c2410c', text: 'text-orange-700', bg: 'bg-orange-50', border: 'border-orange-200', glow: 'shadow-[0_0_40px_-10px_rgba(194,65,12,0.12)]'  },
  CRITICAL: { ring: '#b91c1c', text: 'text-red-700',    bg: 'bg-red-50',    border: 'border-red-200',    glow: 'shadow-[0_0_40px_-10px_rgba(185,28,28,0.15)]'  },
  UNKNOWN:  { ring: '#6b7280', text: 'text-gray-500',   bg: 'bg-gray-50',   border: 'border-gray-200',   glow: '' },
};

// ─── Formatters ───────────────────────────────────────────────────────────────

export function shortenAddress(addr: string | null | undefined, chars = 4): string {
  if (!addr) return '—';
  if (addr.length <= chars * 2 + 2) return addr;
  return `${addr.slice(0, chars + 2)}…${addr.slice(-chars)}`;
}

export function fmtNum(n: number | null | undefined, opts?: Intl.NumberFormatOptions): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', opts).format(n);
}

export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return 'unverified';
  return `${n.toFixed(2)}%`;
}

// ─── Venue badge ──────────────────────────────────────────────────────────────

export function VenueBadge({ venue }: { venue?: 'v3' | 'v4' | null }) {
  if (!venue) return null;
  return venue === 'v4' ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-widest text-primary">
      Uniswap V4
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-widest text-primary/70">
      Uniswap V3
    </span>
  );
}

export function HookBadge({ hookAddress }: { hookAddress?: string | null }) {
  const NULL_HOOK = '0x0000000000000000000000000000000000000000';
  if (!hookAddress || hookAddress.toLowerCase() === NULL_HOOK) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-[11px] font-mono text-amber-700"
      title={hookAddress}
    >
      🪝 Hook: {hookAddress.slice(0, 6)}…{hookAddress.slice(-4)}
    </span>
  );
}

// ─── Score gauge ──────────────────────────────────────────────────────────────

export function ScoreGauge({ score, verdict }: { score: number; verdict: VerdictLevel }) {
  const tone = VERDICT_TONE[verdict] ?? VERDICT_TONE.MEDIUM;
  const size = 168;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const failed = verdict === 'UNKNOWN' || score < 0;
  const pct = failed ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const offset = c * (1 - pct);

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        {/* Track */}
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="oklch(0.87 0.02 250)" strokeWidth={stroke} />
        {!failed && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={tone.ring}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 900ms ease-out' }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {failed ? (
          <>
            <span className="text-2xl font-bold text-muted-foreground">—</span>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground text-center px-4">scoring failed</span>
          </>
        ) : (
          <>
            <span className="text-4xl font-bold font-mono tracking-tight text-primary">{score.toFixed(2)}</span>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">/ 100 risk</span>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Score breakdown ──────────────────────────────────────────────────────────

export function ScoreBreakdown({
  breakdown,
}: {
  breakdown: Array<{ id: string; label: string; contribution: number }>;
}) {
  if (!breakdown || breakdown.length === 0) {
    return <p className="text-sm text-muted-foreground">No breakdown available for this analysis.</p>;
  }
  const sorted = [...breakdown].sort((a, b) => b.contribution - a.contribution);
  const max = Math.max(...sorted.map((b) => b.contribution), 1);
  const total = sorted.reduce((sum, b) => sum + b.contribution, 0);

  return (
    <div className="space-y-3">
      {sorted.map((b, i) => (
        <div key={b.id + i}>
          <div className="flex items-center justify-between mb-1 text-xs gap-3">
            <span className="text-muted-foreground">{b.label}</span>
            <span className="font-mono text-foreground flex-shrink-0">+{b.contribution.toFixed(2)}</span>
          </div>
          <MeterBar
            pct={(b.contribution / max) * 100}
            tone={b.contribution / max > 0.66 ? 'red' : b.contribution / max > 0.33 ? 'orange' : 'sky'}
          />
        </div>
      ))}
      <div className="pt-2 mt-2 border-t border-border flex justify-between text-xs">
        <span className="text-muted-foreground uppercase tracking-wide">Sum of contributions</span>
        <span className="font-mono text-foreground">{total.toFixed(2)}</span>
      </div>
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export function Panel({
  title,
  icon,
  right,
  children,
  className = '',
}: {
  title: string;
  icon?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-border bg-background shadow-sm ${className}`}>
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-primary">
          {icon && <span className="text-base leading-none">{icon}</span>}
          {title}
        </h2>
        {right}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────────────

export function StatCard({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'bad' | 'warn' | 'neutral';
}) {
  const toneClass = {
    good:    'text-green-700',
    bad:     'text-red-700',
    warn:    'text-amber-700',
    neutral: 'text-foreground',
  }[tone];

  return (
    <div className="rounded-xl border border-border bg-brand-cream/40 p-4">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">{label}</p>
      <p className={`text-xl font-mono font-semibold ${toneClass}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

// ─── VerifiedPill ─────────────────────────────────────────────────────────────

export function VerifiedPill({ state }: { state: 'verified' | 'unverified' | 'flagged' | 'pending' }) {
  const map = {
    verified:   { label: 'Verified',   cls: 'bg-green-50 text-green-700 border-green-200' },
    unverified: { label: 'Unverified', cls: 'bg-gray-50 text-gray-500 border-gray-200' },
    flagged:    { label: 'Flagged',    cls: 'bg-red-50 text-red-700 border-red-200' },
    pending:    { label: 'Pending',    cls: 'bg-blue-50 text-blue-600 border-blue-200' },
  }[state];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${map.cls}`}>
      {map.label}
    </span>
  );
}

// ─── HolderBars ──────────────────────────────────────────────────────────────

export function HolderBars({
  holders,
  deployerAddress,
}: {
  holders: Array<{ address: string; balance: string; pct: number }>;
  deployerAddress?: string | null;
}) {
  if (!holders || holders.length === 0) {
    return <p className="text-sm text-muted-foreground">Holder scan returned no data.</p>;
  }
  const max = Math.max(...holders.map((h) => h.pct), 1);
  return (
    <div className="space-y-3">
      {holders.map((h, i) => {
        const isDeployer =
          deployerAddress && h.address.toLowerCase() === deployerAddress.toLowerCase();
        return (
          <div key={h.address + i}>
            <div className="flex items-center justify-between mb-1 text-xs">
              <span className="font-mono text-muted-foreground">
                #{i + 1} {shortenAddress(h.address)}
                {isDeployer && (
                  <span className="ml-2 rounded bg-orange-100 px-1.5 py-0.5 text-[10px] text-orange-700">
                    DEPLOYER
                  </span>
                )}
              </span>
              <span className="font-mono text-foreground">{h.pct.toFixed(2)}%</span>
            </div>
            <div className="h-2 w-full rounded-full bg-border overflow-hidden">
              <div
                className={`h-full rounded-full ${isDeployer ? 'bg-orange-500' : 'bg-primary'}`}
                style={{ width: `${(h.pct / max) * 100}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── TradeFlowBar ─────────────────────────────────────────────────────────────

export function TradeFlowBar({ buyCount, sellCount }: { buyCount: number; sellCount: number }) {
  const total = buyCount + sellCount;
  const buyPct = total > 0 ? (buyCount / total) * 100 : 50;
  const sellPct = 100 - buyPct;
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-border">
        <div className="h-full bg-green-500" style={{ width: `${buyPct}%` }} />
        <div className="h-full bg-red-500" style={{ width: `${sellPct}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between text-xs font-mono">
        <span className="text-green-700">{buyCount} buys</span>
        <span className="text-red-700">{sellCount} sells</span>
      </div>
    </div>
  );
}

// ─── MeterBar ────────────────────────────────────────────────────────────────

export function MeterBar({ pct, tone = 'sky' }: { pct: number; tone?: 'sky' | 'orange' | 'red' }) {
  const color = { sky: 'bg-primary/60', orange: 'bg-orange-500', red: 'bg-red-500' }[tone];
  return (
    <div className="h-2 w-full rounded-full bg-border overflow-hidden">
      <div
        className={`h-full rounded-full ${color}`}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </div>
  );
}

// ─── AgentPipeline ────────────────────────────────────────────────────────────

const TOOL_META: Record<string, { label: string; desc: string; icon: string }> = {
  getHolderLedger:    { label: 'Holder Ledger Scan',        desc: 'Walked on-chain Transfer logs to reconstruct top holder balances.',                                icon: '📒' },
  getSourceCode:      { label: 'Source Verification',       desc: 'Pulled verified source from Etherscan and scanned for suspicious functions.',                      icon: '📜' },
  runSellTest:        { label: 'Honeypot Sell Simulation',  desc: 'Simulated a sell from a real holder to check the token can actually be sold.',                     icon: '🧪' },
  checkLpLock:        { label: 'LP Lock Check',             desc: 'Checked whether the LP position is burned, locked, or held by an EOA.',                            icon: '🔒' },
  getDeployerHistory: { label: 'Deployer History Lookup',   desc: "Checked persistent memory for the deployer's prior token launches.",                               icon: '🕵️' },
  getTradeHistory:    { label: 'Trade Activity Scan',       desc: 'Scanned swap events for wash-trading and bot-volume patterns.',                                     icon: '🔁' },
};

function toolMeta(name: string) {
  return TOOL_META[name] ?? { label: name, desc: 'Agent tool call.', icon: '⚙️' };
}

export function AgentPipeline({ transcript }: { transcript: ToolCallRecord[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <div className="relative pl-8">
      {/* Vertical connector */}
      <div className="absolute left-[15px] top-2 bottom-2 w-px bg-gradient-to-b from-primary/40 via-border to-border" />
      <div className="space-y-5">
        {transcript.map((call, i) => {
          const meta = toolMeta(call.name);
          const isOpen = openIdx === i;
          const outputStr = safeStringify(call.output);
          return (
            <div key={i} className="relative">
              <div className="absolute -left-8 top-0 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background text-sm shadow-sm">
                {meta.icon}
              </div>
              <button
                onClick={() => setOpenIdx(isOpen ? null : i)}
                className="w-full rounded-xl border border-border bg-background px-4 py-3 text-left hover:bg-brand-cream/40 transition-colors shadow-sm"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      Step {i + 1} · {meta.label}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">{meta.desc}</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-[11px] font-mono text-muted-foreground">
                      {new Date(call.ts).toLocaleTimeString()}
                    </span>
                    <span className={`text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`}>▾</span>
                  </div>
                </div>
                {isOpen && (
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Called with</p>
                      <pre className="max-h-48 overflow-auto rounded-lg bg-brand-cream/60 border border-border p-2 text-[11px] font-mono text-foreground">
                        {safeStringify(call.args)}
                      </pre>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Returned</p>
                      <pre className="max-h-48 overflow-auto rounded-lg bg-brand-cream/60 border border-border p-2 text-[11px] font-mono text-foreground">
                        {outputStr}
                      </pre>
                    </div>
                  </div>
                )}
              </button>
            </div>
          );
        })}
        {/* Terminal step */}
        <div className="relative">
          <div className="absolute -left-8 top-0 flex h-8 w-8 items-center justify-center rounded-full border border-green-200 bg-green-50 text-sm">
            🏁
          </div>
          <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
            Evidence collection complete — handed off to the LLM scorer for a final verdict.
          </div>
        </div>
      </div>
    </div>
  );
}

function safeStringify(val: unknown): string {
  try {
    const str = JSON.stringify(val, null, 2) ?? 'null';
    return str.length > 800 ? str.slice(0, 800) + '\n…' : str;
  } catch {
    return String(val);
  }
}