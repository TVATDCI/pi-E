// extensions/orchestration-engine/session-state.ts — process-scoped shared session state.
// Holds the cumulative usage accumulator for the usageBudget pre-launch gate (PORT-PLAN-v0.40.md ①),
// shared across BOTH `dispatch` (index.ts) and `run_chain` (chain-runner.ts) so a chain's reported
// usage counts toward the SAME gate as direct dispatches. Resets on pi restart ("reported, no
// reservation" — no durability, no cross-session leakage). Pure module — no extension entry.
import type { CostSummary } from "../budgets/types.ts";

export const sessionUsage: CostSummary = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

/** Accumulate a completed run's reported usage into the session total. No-op on undefined. */
export function accumulateUsage(
  usage: { input: number; output: number; cost: number } | undefined,
): void {
  if (!usage) return;
  sessionUsage.inputTokens += usage.input;
  sessionUsage.outputTokens += usage.output;
  sessionUsage.costUsd += usage.cost;
}
