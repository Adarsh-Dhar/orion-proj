/**
 * tweet-format.ts — converts a RugCheckResult into a tweet thread.
 *
 * Every string is sliced to ≤ 275 chars (safety margin below Twitter's 280)
 * so Gemini's unbounded summary/flag text never silently truncates a post.
 *
 * Exports:
 *   formatTweetThread(result, meta)       — standalone auto-post thread
 *   formatTweetReply(result, meta, answer) — mention-reply thread (answer first)
 */

import type { RugCheckResult } from "./rugcheck-types.js";

// ─── Shared constants ─────────────────────────────────────────────────────────

const MAX = 275; // leave 5 chars breathing room under Twitter's 280

const VERDICT_EMOJI: Record<string, string> = {
  LOW:      "🟢",
  MEDIUM:   "🟡",
  HIGH:     "🟠",
  CRITICAL: "🔴",
};

const SEVERITY_EMOJI: Record<string, string> = {
  LOW:      "🟢",
  MEDIUM:   "🟡",
  HIGH:     "🟠",
  CRITICAL: "🔴",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cap(s: string): string {
  return s.slice(0, MAX);
}

/** Splits an array into chunks of size n */
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ─── Core thread builder ──────────────────────────────────────────────────────

/**
 * Builds the standard rug-check thread from a RugCheckResult.
 *
 * Tweet 1  — verdict header + score + address + summary
 * Tweet 2+ — risk flags (2 per tweet to stay under the char limit)
 * Last tweet — ownership / top-holders / liquidity snapshot + BaseScan link
 */
export function formatTweetThread(
  r: RugCheckResult,
  meta: { name: string; symbol: string; totalSupplyFormatted: string }
): string[] {
  const tweets: string[] = [];
  const emoji = VERDICT_EMOJI[r.verdict] ?? "⚪";

  // ── Tweet 1: header ────────────────────────────────────────────────────────
  tweets.push(
    cap(
      `${emoji} ${r.verdict} RISK — ${meta.name} ($${meta.symbol})\n` +
      `Score: ${r.score}/100\n` +
      `${r.tokenAddress}\n\n` +
      r.summary
    )
  );

  // ── Flag tweets: 2 flags each ──────────────────────────────────────────────
  if (r.flags.length > 0) {
    for (const pair of chunk(r.flags, 2)) {
      const lines = pair.map(
        (f) => `${SEVERITY_EMOJI[f.severity] ?? "⚠️"} ${f.label}\n   ${f.detail}`
      );
      tweets.push(cap(lines.join("\n\n")));
    }
  }

  // ── Last tweet: snapshot + link ────────────────────────────────────────────
  const ownerLine = r.ownershipRenounced ? "Ownership: renounced ✅" : "Ownership: active ❌";
  const top5Line  = r.top5HoldersPct !== null
    ? `Top 5 holders: ${r.top5HoldersPct.toFixed(0)}%`
    : "Top 5 holders: unknown";
  const liqLine   = r.liquidityLocked === null
    ? "Liquidity: unknown"
    : r.liquidityLocked ? "Liquidity: locked ✅" : "Liquidity: removed ❌";

  tweets.push(
    cap(
      `${ownerLine}\n${top5Line}\n${liqLine}\n\n` +
      `basescan.org/address/${r.tokenAddress}`
    )
  );

  return tweets;
}

// ─── Reply variant ────────────────────────────────────────────────────────────

/**
 * Same as formatTweetThread but prepends the LLM's direct answer to the
 * user's question as tweet 0 of the thread.
 *
 * If no answer is present (shouldn't happen for mention replies, but be safe)
 * it falls back to the plain thread.
 */
export function formatTweetReply(
  r: RugCheckResult,
  meta: { name: string; symbol: string; totalSupplyFormatted: string }
): string[] {
  const base = formatTweetThread(r, meta);

  if (r.answer) {
    // Unshift the answer as the opening reply tweet
    base.unshift(cap(r.answer));
  }

  return base;
}
