/**
 * agents/index.ts — barrel export for the multi-agent scoring pipeline.
 *
 * Agents living here:
 *   - orchestrator.ts  — dispatches the specialists below, merges their
 *                        flags/transcripts, validates grounding
 *   - grounding.ts     — structural validator preventing the pipeline from
 *                        citing flags no specialist's tool call supports
 *   - tools.ts         — tool schemas + per-specialist dispatchers
 *   - types.ts         — SpecialistResult/SpecialistAgent contract
 *   - specialists/*.ts — the five domain specialists themselves
 *
 * Single-shot scoring (llm-score.ts), the Gemini source-code audit
 * (source-audit.ts), and the shared Gemini transport (gemini-client.ts)
 * moved up to src/lib/ — they aren't part of the agent pipeline itself.
 *
 * Prefer importing directly from the specific module (e.g.
 * "./agents/orchestrator.js") in hot paths — this barrel is mainly for
 * discoverability and for call sites that need more than one agent.
 */

export * from "./orchestrator.js";
export * from "./grounding.js";
export * from "./tools.js";
export * from "./types.js";
export * from "./specialists/index.js";
