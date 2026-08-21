'use client';

import { useState } from 'react';
import type { RiskLevel, ToolCallRecord } from './types';

// ─── Shared tone tokens ──────────────────────────────────────────────────────

export const VERDICT_TONE: Record<RiskLevel, { ring: string; text: string; bg: string; border: string; glow: string }> = {
  LOW:      { ring: '#34D399', text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', glow: 'shadow-[0_0_40px_-10px_rgba(52,211,153,0.5)]' },
  MEDIUM:   { ring: '#FBBF24', text: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/30',   glow: 'shadow-[0_0_40px_-10px_rgba(251,191,36,0.5)]' },
  HIGH:     { ring: '#FB923C', text: 'text-orange-400',  bg: 'bg-orange-500/10',  border: 'border-orange-500/30',  glow: 'shadow-[0_0_40px_-10px_rgba(251,146,60,0.5)]' },
  CRITICAL: { ring: '#F87171', text: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/30',     glow: 'shadow-[0_0_40px_-10px_rgba(248,113,113,0.6)]' },
};

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

// ─── Score gauge ──────────────────────────────────────────────────────────────

export function ScoreGauge({ score, verdict }: { score: number; verdict: RiskLevel }) {
  const tone = VERDICT_TONE[verdict] ?? VERDICT_TONE.MEDIUM;
  const size = 168;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const offset = c * (1 - pct);

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1F2428" strokeWidth={stroke} />
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
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-bold font-mono tracking-tight text-white">{score}</span>
        <span className="text-[10px] uppercase tracking-widest text-zinc-500">/ 100 risk</span>
      </div>
    </div>
  );
}

// ─── Layout primitives ─────────────────────────────────────────────────────────

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
    <section className={`rounded-xl border border-zinc-800 bg-zinc-900/60 backdrop-blur-sm ${className}`}>
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-zinc-300">
          {icon && <span className="text-base leading-none">{icon}</span>}
          {title}
        </h2>
        {right}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

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
    good: 'text-emerald-400',
    bad: 'text-red-400',
    warn: 'text-amber-400',
    neutral: 'text-white',
  }[tone];

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">{label}</p>
      <p className={`text-xl font-mono font-semibold ${toneClass}`}>{value}</p>
      {sub && <p className="text-xs text-zinc-500 mt-1">{sub}</p>}
    </div>
  );
}

/** Small check/warn/unknown pill used to show whether a claim was actually verified on-chain. */
export function VerifiedPill({ state }: { state: 'verified' | 'unverified' | 'flagged' }) {
  const map = {
    verified: { label: 'Verified', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
    unverified: { label: 'Unverified', cls: 'bg-zinc-500/10 text-zinc-400 border-zinc-600/40' },
    flagged: { label: 'Flagged', cls: 'bg-red-500/10 text-red-400 border-red-500/30' },
  }[state];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${map.cls}`}>
      {map.label}
    </span>
  );
}

// ─── Holder distribution bar chart ─────────────────────────────────────────────

export function HolderBars({
  holders,
  deployerAddress,
}: {
  holders: Array<{ address: string; balance: string; pct: number }>;
  deployerAddress?: string | null;
}) {
  if (!holders || holders.length === 0) {
    return <p className="text-sm text-zinc-500">Holder scan returned no data.</p>;
  }
  const max = Math.max(...holders.map((h) => h.pct), 1);
  return (
    <div className="space-y-3">
      {holders.map((h, i) => {
        const isDeployer = deployerAddress && h.address.toLowerCase() === deployerAddress.toLowerCase();
        return (
          <div key={h.address + i}>
            <div className="flex items-center justify-between mb-1 text-xs">
              <span className="font-mono text-zinc-400">
                #{i + 1} {shortenAddress(h.address)}
                {isDeployer && (
                  <span className="ml-2 rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] text-orange-400">DEPLOYER</span>
                )}
              </span>
              <span className="font-mono text-zinc-300">{h.pct.toFixed(2)}%</span>
            </div>
            <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
              <div
                className={`h-full rounded-full ${isDeployer ? 'bg-orange-500' : 'bg-sky-500'}`}
                style={{ width: `${(h.pct / max) * 100}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Buy/sell trade flow bar ────────────────────────────────────────────────────

export function TradeFlowBar({ buyCount, sellCount }: { buyCount: number; sellCount: number }) {
  const total = buyCount + sellCount;
  const buyPct = total > 0 ? (buyCount / total) * 100 : 50;
  const sellPct = 100 - buyPct;
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full bg-emerald-500" style={{ width: `${buyPct}%` }} />
        <div className="h-full bg-red-500" style={{ width: `${sellPct}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between text-xs font-mono">
        <span className="text-emerald-400">{buyCount} buys</span>
        <span className="text-red-400">{sellCount} sells</span>
      </div>
    </div>
  );
}

export function MeterBar({ pct, tone = 'sky' }: { pct: number; tone?: 'sky' | 'orange' | 'red' }) {
  const color = { sky: 'bg-sky-500', orange: 'bg-orange-500', red: 'bg-red-500' }[tone];
  return (
    <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

// ─── Agent investigation pipeline (diagrammatic tool-call trace) ──────────────

const TOOL_META: Record<string, { label: string; desc: string; icon: string }> = {
  getHolderLedger: { label: 'Holder Ledger Scan', desc: 'Walked on-chain Transfer logs to reconstruct top holder balances.', icon: '📒' },
  getSourceCode: { label: 'Source Verification', desc: 'Pulled verified source from Etherscan and scanned for suspicious functions.', icon: '📜' },
  runSellTest: { label: 'Honeypot Sell Simulation', desc: 'Simulated a sell from a real holder to check the token can actually be sold.', icon: '🧪' },
  checkLpLock: { label: 'LP Lock Check', desc: 'Checked whether the LP position is burned, locked, or held by an EOA.', icon: '🔒' },
  getDeployerHistory: { label: 'Deployer History Lookup', desc: "Checked persistent memory for the deployer's prior token launches.", icon: '🕵️' },
  getTradeHistory: { label: 'Trade Activity Scan', desc: 'Scanned swap events for wash-trading and bot-volume patterns.', icon: '🔁' },
};

function toolMeta(name: string) {
  return TOOL_META[name] ?? { label: name, desc: 'Agent tool call.', icon: '⚙️' };
}

export function AgentPipeline({ transcript }: { transcript: ToolCallRecord[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <div className="relative pl-8">
      <div className="absolute left-[15px] top-2 bottom-2 w-px bg-gradient-to-b from-sky-500/60 via-zinc-700 to-zinc-800" />
      <div className="space-y-5">
        {transcript.map((call, i) => {
          const meta = toolMeta(call.name);
          const isOpen = openIdx === i;
          const outputStr = safeStringify(call.output);
          return (
            <div key={i} className="relative">
              <div className="absolute -left-8 top-0 flex h-8 w-8 items-center justify-center rounded-full border border-sky-500/40 bg-zinc-950 text-sm">
                {meta.icon}
              </div>
              <button
                onClick={() => setOpenIdx(isOpen ? null : i)}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-left hover:border-zinc-700 transition-colors"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">
                      Step {i + 1} · {meta.label}
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5">{meta.desc}</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-[11px] font-mono text-zinc-500">
                      {new Date(call.ts).toLocaleTimeString()}
                    </span>
                    <span className={`text-zinc-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}>▾</span>
                  </div>
                </div>
                {isOpen && (
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Called with</p>
                      <pre className="max-h-48 overflow-auto rounded bg-black/40 p-2 text-[11px] font-mono text-zinc-400">
                        {safeStringify(call.args)}
                      </pre>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Returned</p>
                      <pre className="max-h-48 overflow-auto rounded bg-black/40 p-2 text-[11px] font-mono text-zinc-400">
                        {outputStr}
                      </pre>
                    </div>
                  </div>
                )}
              </button>
            </div>
          );
        })}
        <div className="relative">
          <div className="absolute -left-8 top-0 flex h-8 w-8 items-center justify-center rounded-full border border-emerald-500/40 bg-zinc-950 text-sm">
            🏁
          </div>
          <div className="rounded-lg border border-emerald-800/40 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-400">
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
