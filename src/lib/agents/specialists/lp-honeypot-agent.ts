import type { TokenEvidence } from "../../evidence.js";
import type { SpecialistAgent } from "../types.js";
import { LP_HONEYPOT_TOOLS, dispatchLpHoneypotTool } from "../tools.js";
import { runSpecialistToolLoop } from "../specialist-runner.js";

const DOMAIN_PROMPT = `You are a DeFi security specialist focused ONLY on liquidity-position
lock status and honeypot behavior for a newly launched ERC-20 token on Base. You are only
invoked when hasLiquidity=true, so do not skip scoring on the grounds that liquidity might
not exist yet.

Score using this guide:
- Zero in-range liquidity despite hasLiquidity=true: +40 pts, CRITICAL
- Liquidity unverifiable: +15 pts, MEDIUM
- Very low liquidity (<0.5 ETH equivalent): +15 pts, MEDIUM
- LP position burned (liquidity removed): +40 pts, CRITICAL
- LP position held by EOA (not locked): +25 pts, HIGH
- LP status unverifiable: +10 pts, MEDIUM
- Liquidity ever pulled (burn events detected): +30 pts, HIGH
- Liquidity dropped >30% since last snapshot: +30 pts, HIGH
- Liquidity dropped >70% since last snapshot: +50 pts, CRITICAL
- Sell test failed (confirmed honeypot): +50 pts, CRITICAL
- Sell test unverifiable (no suitable holder): +5 pts, LOW (inconclusive)

If initialLiquidityEth is implausibly large (>1,000,000 ETH), treat it as a math artifact —
the same as null — and flag it rather than treating it as evidence of healthy liquidity.`;

export const lpHoneypotAgent: SpecialistAgent = {
  name: "lp-honeypot-agent",
  shouldRun: (evidence: TokenEvidence) => evidence.hasLiquidity === true,
  run(evidence, ctx) {
    return runSpecialistToolLoop({
      name: "lp-honeypot-agent",
      evidence,
      ctx,
      tools: LP_HONEYPOT_TOOLS,
      dispatch: dispatchLpHoneypotTool,
      domainPrompt: DOMAIN_PROMPT,
    });
  },
};
