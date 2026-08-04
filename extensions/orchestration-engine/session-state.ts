// extensions/orchestration-engine/session-state.ts — process-scoped shared session state.
// Holds the cumulative usage accumulator for the usageBudget pre-launch gate (PORT-PLAN-v0.40.md ①),
// shared across BOTH `dispatch` (index.ts) and `run_chain` (chain-runner.ts) so a chain's reported
// usage counts toward the SAME gate as direct dispatches. "Reported, no reservation" semantics.
//
// SESSION SCOPE (honest): the singleton lives for the process lifetime, BUT index.ts resets it on
// `session_start` AND on in-process `/resume` (a session-ID change detected via `turn_start`, per
// the mini-task-tracker.ts pattern) — so a resumed session is NOT charged the prior session's spend.
// It also zeroes on a full process restart. Pure module — no extension entry (imported only).
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

/** Zero the session accumulator. Called on `session_start` and on in-process `/resume` (session-ID
 *  change detected via `turn_start`) so a resumed session isn't charged the prior session's spend
 *  (review-loop round-2 F2b). */
export function resetUsage(): void {
  sessionUsage.inputTokens = 0;
  sessionUsage.outputTokens = 0;
  sessionUsage.costUsd = 0;
}
