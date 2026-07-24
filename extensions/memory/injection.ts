// Pure injection pipeline (Fork B + F1 per-turn re-injection).
// Composes: ranker -> budgeter -> formatter. No Pi dependencies -> fully unit-testable.
// The Pi before_agent_start hook (index.ts) calls this each turn and appends the block.

import type { MemoryRecord } from "./schema.ts";
import { rankForInjection } from "./ranker.ts";
import { applyBudget, DEFAULT_TOKEN_BUDGET } from "./budget.ts";
import { formatMemoryBlock } from "./formatter.ts";

export interface InjectionResult {
  /** The formatted <memory-context> block, or "" when the store is empty. */
  block: string;
  kept: MemoryRecord[];
  cut: MemoryRecord[];
  keptCount: number;
  cutCount: number;
  estimatedTokens: number;
}

/**
 * Build the memory-context block for injection. Pure: same input -> same output.
 * Records are ranked (category > provenance > recency), trimmed to the token budget,
 * and formatted into the XML-fenced block. Empty input -> "" (caller skips injection).
 */
export function buildInjection(
  records: readonly MemoryRecord[],
  budget: number = DEFAULT_TOKEN_BUDGET,
): InjectionResult {
  const ranked = rankForInjection(records);
  const budgeted = applyBudget(ranked, budget);
  const block = formatMemoryBlock(budgeted.kept);
  return {
    block,
    kept: budgeted.kept,
    cut: budgeted.cut,
    keptCount: budgeted.kept.length,
    cutCount: budgeted.cut.length,
    estimatedTokens: budgeted.estimatedTokens,
  };
}
