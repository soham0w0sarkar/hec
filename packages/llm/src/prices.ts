import type { Usage } from "./types";

/** Rupees per one million tokens, excluding GST. Source: Sarvam pricing page (Oct 2026 changelog). */
export type Price = { input: number; cachedInput: number; output: number };

export const PRICES_INR: Record<string, Price> = {
  "sarvam-105b": { input: 15, cachedInput: 5, output: 60 },
  "sarvam-105b-conversations": { input: 15, cachedInput: 5, output: 60 },
};

/**
 * Cost of one request. Unknown models return null rather than a guess. Cached tokens are part
 * of the input count, so they are billed at the cached rate and the rest at the input rate.
 */
export function costInr(model: string, usage: Pick<Usage, "inputTokens" | "outputTokens" | "cachedInputTokens">): number | null {
  const price = PRICES_INR[model];
  if (!price) return null;
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  const rupees =
    (uncached * price.input + cached * price.cachedInput + usage.outputTokens * price.output) / 1_000_000;
  // Round to the precision the database stores (numeric(12,4)).
  return Math.round(rupees * 10_000) / 10_000;
}
