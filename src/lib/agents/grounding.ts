/**
 * grounding.ts — numeric-provenance validator for agentic LLM scoring.
 *
 * Ensures that every numeric fact in the LLM's flags can be traced back to
 * a tool result, preventing hallucination of numbers.
 */

import type { ToolCallRecord, RiskFlag } from "../rugcheck-types.js";

// ─── Number extraction ───────────────────────────────────────────────────────────

/**
 * Extract all numeric tokens from a string or object.
 * Returns a set of unique numbers found.
 */
function extractAllNumbers(inputs: unknown[]): Set<number> {
  const numbers = new Set<number>();
  
  for (const input of inputs) {
    const str = typeof input === "string" ? input : JSON.stringify(input);
    
    // Match numbers including decimals, percentages, and large numbers
    const numberPattern = /-?\d+(?:\.\d+)?%?/g;
    const matches = str.match(numberPattern);
    
    if (matches) {
      for (const match of matches) {
        // Remove % sign if present and parse as number
        const cleanMatch = match.replace("%", "");
        const num = parseFloat(cleanMatch);
        if (!isNaN(num) && isFinite(num)) {
          numbers.add(num);
        }
      }
    }
  }
  
  return numbers;
}

// ─── Grounding validator ─────────────────────────────────────────────────────────

/**
 * Validate that every numeric fact in the flags appears in the tool results.
 * Returns false if any number in the flags is not present in the transcript.
 */
export function validateGrounding(flags: RiskFlag[], transcript: ToolCallRecord[]): boolean {
  // Extract all numbers from tool results
  const toolOutputs = transcript.map(t => t.output);
  const evidenceNumbers = extractAllNumbers(toolOutputs);
  
  // For each flag, check that all numbers in its detail appear in evidence
  for (const flag of flags) {
    const numbersInDetail = extractAllNumbers([flag.detail]);
    
    for (const num of numbersInDetail) {
      // Allow some tolerance for floating point comparisons
      const found = Array.from(evidenceNumbers).some(
        evidenceNum => Math.abs(evidenceNum - num) < 0.01
      );
      
      if (!found) {
        console.warn(`[grounding] Ungrounded number ${num} in flag "${flag.id}": ${flag.detail}`);
        return false;
      }
    }
  }
  
  return true;
}
