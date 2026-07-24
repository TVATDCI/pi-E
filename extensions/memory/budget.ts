// Token budgeter (Fork B). Walks a RANKED list and keeps records until the next
// would exceed the budget; the rest are cut (lowest rank first, per the ranker order).
//
// tiktoken is NOT installed in this environment, so we use a chars/4 heuristic.
// It is a SOFT cap (~2000 tokens) for injection sizing, not billing — heuristic is
// ~good-enough and keeps v1 dependency-free (Pi independence). Swappable to tiktoken
// in v1.1 by replacing estimateTokens.
//
// Pure: same input -> same output, no side effects. The caller owns the truncation
// log (and per F1, logs on signature-change, not every turn).

import type { MemoryRecord } from "./schema.ts";

export const DEFAULT_TOKEN_BUDGET = 2000;
const CHARS_PER_TOKEN = 4;

export interface BudgetResult {
  /** Records within budget, in rank order. */
  kept: MemoryRecord[];
  /** Records cut by the budget, in rank order (lowest rank first cut). */
  cut: MemoryRecord[];
  /** Estimated tokens consumed by the kept records. */
  estimatedTokens: number;
}

/** Estimate tokens for a string via the chars/4 heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Walk a ranked list; keep records while they fit, cut the rest.
 * costFn defaults to value-based estimation; the caller may pass a formatter-aware
 * cost (e.g. r => estimateTokens(formatRecord(r))) for a tighter budget.
 */
export function applyBudget(
  ranked: readonly MemoryRecord[],
  budget: number = DEFAULT_TOKEN_BUDGET,
  costFn: (rec: MemoryRecord) => number = (r) => estimateTokens(r.value),
): BudgetResult {
  const kept: MemoryRecord[] = [];
  const cut: MemoryRecord[] = [];
  let used = 0;
  for (const rec of ranked) {
    const cost = costFn(rec);
    if (used + cost <= budget) {
      kept.push(rec);
      used += cost;
    } else {
      cut.push(rec);
    }
  }
  return { kept, cut, estimatedTokens: used };
}
