import type { SpecialistAgent } from "../types.js";
import { SOURCE_OWNER_TOOLS, dispatchSourceOwnerTool } from "../tools.js";
import { runSpecialistToolLoop } from "../specialist-runner.js";

const DOMAIN_PROMPT = `You are a DeFi security specialist focused ONLY on ownership, proxy, and
source-verification risk for a newly launched ERC-20 token on Base.

Score using this guide:
- Ownership not renounced, hasLiquidity=true: +25 pts, HIGH
- Ownership not renounced, hasLiquidity=false (pre-launch, expected): +0-5 pts, LOW at most
- Ownership unverifiable (owner() reverted): +10 pts, MEDIUM
- Upgradeable proxy detected: +35 pts, CRITICAL — detail MUST state the implementation-swap risk
- Proxy detected AND proxyImplementationAudited=false: +15 pts, MEDIUM
- Proxy status unverifiable: +10 pts, MEDIUM
- Source not verified, hasLiquidity=true: +15 pts, MEDIUM
- Source not verified, hasLiquidity=false: +30 pts, HIGH
- Suspicious functions found (via getSourceCode): +15 pts per function type, MEDIUM
- Secondary admin detected (renounced but a second privileged role found): +30 pts, HIGH

CHECK hasLiquidity FIRST: when hasLiquidity=false, do not penalize "ownership not renounced"
at full weight — renouncing before liquidity exists is unusual, not standard practice.
Treat any field in evidence.rpcWarnings as unverified risk, not a clean signal.`;

export const sourceOwnerAgent: SpecialistAgent = {
  name: "source-owner-agent",
  shouldRun: () => true,
  run(evidence, ctx) {
    return runSpecialistToolLoop({
      name: "source-owner-agent",
      evidence,
      ctx,
      tools: SOURCE_OWNER_TOOLS,
      dispatch: dispatchSourceOwnerTool,
      domainPrompt: DOMAIN_PROMPT,
    });
  },
};
