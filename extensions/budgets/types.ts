// extensions/budgets/types.ts — shared budget type definitions.
// Faithful port from pi-subagents@0.40 src/shared/types.ts (verified 2026-08-04, L108-150 / L513 / L822-844).
// Part of the budget subsystem (PORT-PLAN-v0.40.md ①). Pure library — imported by the three
// budget modules and (later) by spawn/dispatch wiring. No runtime behavior here.
//
// NOTE: these mirror the upstream types verbatim so a future port of budget *enforcement*
// (decision functions, state constructors) stays source-compatible. Do not rename fields.

/** Caller-facing turn-budget config (before grace defaults are applied). */
export interface TurnBudgetConfig {
  maxTurns: number;
  graceTurns?: number;
}

/** Resolved turn budget — graceTurns always present after resolution. */
export interface ResolvedTurnBudget {
  maxTurns: number;
  graceTurns: number;
}

/** Caller-facing tool-budget config. `block` defaults to read-only tools when omitted. */
export interface ToolBudgetConfig {
  soft?: number;
  hard: number;
  block?: string[] | "*";
}

/** Resolved tool budget — `block` is always present after resolution (never undefined). */
export interface ResolvedToolBudget {
  soft?: number;
  hard: number;
  block: string[] | "*";
}

export type ToolBudgetOutcome = "within-budget" | "soft-reached" | "hard-blocked";

export interface ToolBudgetState extends ResolvedToolBudget {
  outcome: ToolBudgetOutcome;
  toolCount: number;
  softReachedAt?: number;
  hardReachedAt?: number;
  blockedTool?: string;
}

export type TurnBudgetOutcome =
  | "within-budget"
  | "wrap-up-requested"
  | "termination-deferred"
  | "exceeded";

export interface TurnBudgetState extends ResolvedTurnBudget {
  outcome: TurnBudgetOutcome;
  turnCount: number;
  wrapUpRequestedAtTurn?: number;
  terminationDeferredAtTurn?: number;
  exceededAtTurn?: number;
}

/** Reported cost totals consumed by usage-budget state computation. */
export type CostSummary = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export interface UsageBudgetLimitConfig {
  soft?: number;
  hard: number;
}

export interface UsageBudgetConfig {
  tokens?: UsageBudgetLimitConfig;
  costUsd?: UsageBudgetLimitConfig;
}

export interface UsageBudgetMetricState extends UsageBudgetLimitConfig {
  used: number;
  outcome: "within-budget" | "soft-exceeded" | "hard-exceeded";
}

export interface UsageBudgetState {
  version: 1;
  /** Enforced from usage reported by completed or streaming child runs; no reservation estimates. */
  source: "reported";
  tokens?: UsageBudgetMetricState;
  costUsd?: UsageBudgetMetricState;
  exhausted: boolean;
  reason?: "tokens" | "costUsd";
}
