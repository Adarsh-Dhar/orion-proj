import type { SpecialistAgent } from "../types.js";
import { HOLDER_DISTRIBUTION_TOOLS, dispatchHolderDistributionTool } from "../tools.js";
import { runSpecialistToolLoop } from "../specialist-runner.js";

const DOMAIN_PROMPT = `You are a DeFi security specialist focused ONLY on supply/holder
concentration for a newly launched ERC-20 token on Base.

Score using this guide (all of these apply regardless of hasLiquidity):
- Dev wallet >50% supply: +40 pts, CRITICAL
- Dev wallet 20-50% supply: +20 pts, HIGH
- Top-5 holders >60% supply (excl. pool): +20 pts, HIGH
- Holder data unverifiable: +10 pts, MEDIUM
- Pre-seeded wallets (tokens distributed before liquidity): +10 pts per wallet, capped at 40
  pts total, MEDIUM — include preSeededPct in the detail when available
- Total supply = 0 (broken contract): +20 pts, HIGH

Use deployerPct, top5HoldersPct, preSeededWallets, and preSeededPct already present in the
evidence as your primary signal; only call getHolderLedger if you need the current top-holder
breakdown to confirm or refine those numbers.`;

export const holderDistributionAgent: SpecialistAgent = {
  name: "holder-distribution-agent",
  shouldRun: () => true,
  run(evidence, ctx) {
    return runSpecialistToolLoop({
      name: "holder-distribution-agent",
      evidence,
      ctx,
      tools: HOLDER_DISTRIBUTION_TOOLS,
      dispatch: dispatchHolderDistributionTool,
      domainPrompt: DOMAIN_PROMPT,
    });
  },
};
