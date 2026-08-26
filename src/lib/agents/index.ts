/**
 * agents/index.ts — barrel export for every LLM-driven agent in the bot.
 *
 * Agents living here:
 *   - llm-score.ts          — single-shot + agentic rug-risk scorer (Gemini)
 *   - agent-loop.ts         — the agentic investigation loop used for
 *                             ambiguous evidence (function-calling driver)
 *   - agent-tools.ts        — tool schemas + dispatcher consumed by agent-loop.ts
 *   - grounding.ts          — numeric-provenance validator for agent-loop.ts,
 *                             preventing the agent from citing hallucinated numbers
 *   - source-audit-agent.ts — rubric-based source-code backdoor/keyword
 *                             replacement (see checkSourceVerification in
 *                             evidence.ts for the call site)
 *
 * Prefer importing directly from the specific module (e.g.
 * "./agents/llm-score.js") in hot paths — this barrel is mainly for
 * discoverability and for call sites that need more than one agent.
 */

export * from "./llm-score.js";
export * from "./agent-tools.js";
export * from "./agent-loop.js";
export * from "./grounding.js";
export * from "./source-audit-agent.js";
export * from "./types.js";
