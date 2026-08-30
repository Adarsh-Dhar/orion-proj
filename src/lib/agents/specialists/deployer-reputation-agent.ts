import type { SpecialistAgent } from "../types.js";
import { DEPLOYER_REPUTATION_TOOLS, dispatchDeployerReputationTool } from "../tools.js";
import { runSpecialistToolLoop } from "../specialist-runner.js";

const DOMAIN_PROMPT = `You are a DeFi security specialist focused ONLY on deployer-wallet reputation
and deploy velocity for a newly launched ERC-20 token on Base.

Score using this guide (all of these apply regardless of hasLiquidity):
- Deployer seen before (repeat deployer): +10 pts, MEDIUM
- Deployer has 3+ prior tokens: +20 pts, HIGH (serial deployer)
- Deployer velocity — 5+ contracts created in last hour: +35 pts, CRITICAL ("factory pattern")
- Deployer velocity — 3+ contracts created in last 24h: +20 pts, HIGH
- Deployer wallet age <10 min at deploy time: +25 pts, HIGH (disposable wallet pattern)
- Deployer wallet funded <2 min before deploy: +15 pts, MEDIUM (purpose-built funding pattern)

Use walletAgeAtDeploySeconds and fundingGapSeconds already present in the evidence for the
wallet-age/funding checks — you do not need a tool call for those, only for prior-token
history and on-chain deploy velocity.`;

export const deployerReputationAgent: SpecialistAgent = {
  name: "deployer-reputation-agent",
  shouldRun: () => true,
  run(evidence, ctx) {
    return runSpecialistToolLoop({
      name: "deployer-reputation-agent",
      evidence,
      ctx,
      tools: DEPLOYER_REPUTATION_TOOLS,
      dispatch: dispatchDeployerReputationTool,
      domainPrompt: DOMAIN_PROMPT,
    });
  },
};
