// extensions/budgets/index.ts — budget subsystem barrel.
// Aggregates the turn / tool / usage budget modules (PORT-PLAN-v0.40.md ①) into one import site:
//   import { resolveTurnBudgetConfig, validateToolBudgetConfig, usageBudgetState } from "./budgets/index.ts";
// (or "./budgets" once the loader resolves it). Pure library — no spawn wiring yet.
//
// This file is the subdir entry point pi auto-discovers (docs/extensions.md: `*/index.ts`), so it
// carries a no-op default export exactly like memory/index.ts. The budget modules themselves are
// imported-only and not auto-discovered.

// ── types ───────────────────────────────────────────────────────────────────────
export type {
  TurnBudgetConfig,
  ResolvedTurnBudget,
  TurnBudgetOutcome,
  TurnBudgetState,
  ToolBudgetConfig,
  ResolvedToolBudget,
  ToolBudgetOutcome,
  ToolBudgetState,
  CostSummary,
  UsageBudgetLimitConfig,
  UsageBudgetConfig,
  UsageBudgetMetricState,
  UsageBudgetState,
} from "./types.ts";

// ── turn budget ──────────────────────────────────────────────────────────────────
export {
  DEFAULT_TURN_BUDGET_GRACE_TURNS,
  resolveTurnBudgetConfig,
  appendTurnBudgetSystemPrompt,
  turnBudgetSoftNote,
  turnBudgetExceededMessage,
  turnBudgetDeferredNote,
  formatTurnBudgetOutput,
  initialTurnBudgetState,
  turnBudgetState,
  turnBudgetDeferredState,
  turnBudgetDecision,
} from "./turn-budget.ts";

// ── tool budget ──────────────────────────────────────────────────────────────────
export {
  DEFAULT_TOOL_BUDGET_BLOCK,
  TOOL_BUDGET_ENV,
  TOOL_BUDGET_ZERO_AUTH_ENV,
  normalizeToolBudgetBlock,
  validateToolBudgetConfig,
  initialToolBudgetState,
  toolBudgetState,
  shouldBlockToolForBudget,
  toolBudgetSoftNudge,
  toolBudgetBlockedMessage,
  encodeToolBudgetEnv,
  decodeToolBudgetEnv,
} from "./tool-budget.ts";

// ── usage budget ─────────────────────────────────────────────────────────────────
export {
  validateUsageBudgetConfig,
  usageBudgetState,
  usageBudgetExceededMessage,
} from "./usage-budget.ts";

// ── resolver (resolution + enforcement levels + conservative-policy warnings) ────
// Pure budgets layer; the caller injects the read-only category set (tier-map owns the taxonomy).
export {
  resolveBudgets,
  appendBudgetNudges,
  budgetUsageState,
  hasUsageHardLimit,
} from "./resolver.ts";
export type {
  ResolveBudgetsInput,
  ResolvedBudgets,
  BudgetEnforcement,
} from "./resolver.ts";

// eslint-disable-next-line @typescript-eslint/no-empty-function
export default function (_pi: never): void {
  // No-op extension entry. Budgets are enforced by the spawn/dispatch wiring (PORT-PLAN §①),
  // not at extension-load time. This default export exists only to satisfy pi's `*/index.ts`
  // auto-discovery contract; it intentionally registers nothing.
}
