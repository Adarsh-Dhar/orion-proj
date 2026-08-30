import type { TokenEvidence } from "../../evidence.js";
import type { SpecialistAgent } from "../types.js";
import { TRADING_ACTIVITY_TOOLS, dispatchTradingActivityTool } from "../tools.js";
import { runSpecialistToolLoop } from "../specialist-runner.js";

const DOMAIN_PROMPT = `You are a DeFi security specialist focused ONLY on wash-trading and
bot-volume patterns for a newly launched ERC-20 token on Base. You are only invoked when
hasLiquidity=true.

Score using this guide:
- Round-trip traders >40% of unique traders: +25 pts, HIGH (wash-trading pattern)
- Single trader >50% of total swap volume: +30 pts, HIGH (fake volume / one wallet churning)
- Fewer than 5 unique traders with >20 total swaps: +20 pts, HIGH (thin organic interest,
  likely bot activity)
- Buy/sell ratio wildly skewed toward sells early: +15 pts, MEDIUM (possible dump in progress)
- Trade scan data unverified (tradeScanPartial=true): +10 pts, MEDIUM (incomplete analysis)

Call getTradeHistory to get fresh swap-event data before scoring.`;

export const tradingActivityAgent: SpecialistAgent = {
  name: "trading-activity-agent",
  shouldRun: (evidence: TokenEvidence) => evidence.hasLiquidity === true,
  run(evidence, ctx) {
    return runSpecialistToolLoop({
      name: "trading-activity-agent",
      evidence,
      ctx,
      tools: TRADING_ACTIVITY_TOOLS,
      dispatch: dispatchTradingActivityTool,
      domainPrompt: DOMAIN_PROMPT,
    });
  },
};
