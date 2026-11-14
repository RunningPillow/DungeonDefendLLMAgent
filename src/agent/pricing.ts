// What a run costs. The API reports how many tokens each request used; this turns them into dollars.
//
// Prices are Anthropic's published first-party prices in USD per million tokens, as of November 2026.
// They change, so treat the result as an estimate and update the table when they do.
// Cache reads use the published price where there is one, otherwise 10 % of the input price.
// Writing to the cache costs 1.25x the input price.

const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;

export interface TokenUsage {
  /** Input tokens billed at full price. */
  inputTokens: number;
  /** Input tokens written to the prompt cache (billed higher once, so later requests can read them cheaply). */
  cacheWriteTokens: number;
  /** Input tokens read from the prompt cache (billed far lower). */
  cacheReadTokens: number;
  outputTokens: number;
}

export const NO_USAGE: TokenUsage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** Cost in USD, or null when the model's price is not in the table. */
export function costUsd(model: string, usage: TokenUsage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const perToken = 1 / 1_000_000;
  return (
    usage.inputTokens * price.input * perToken +
    usage.cacheWriteTokens * price.input * CACHE_WRITE_MULTIPLIER * perToken +
    usage.cacheReadTokens * price.cacheRead * perToken +
    usage.outputTokens * price.output * perToken
  );
}
