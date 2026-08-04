// extensions/budgets/resolver.ts — resolve effective budgets, enforcement levels, and conservative-policy warnings.
// Part of the budget subsystem (PORT-PLAN-v0.40.md ①). PURE budgets layer — zero orchestration-engine
// deps. The caller injects the read-only category set (single source of truth lives in tier-map.ts) so
// this module stays decoupled from the category taxonomy and is unit-testable in isolation.
//
// DESIGN (see PORT-PLAN §① + the "conservative orchestration policy"):
//  - Per-field resolution: turn/tool come from tier-map category defaults; usageBudget is session-level.
//    (Caller/config overrides are a known successor — clarify ④, operator config — and slot into
//    ResolveBudgetsInput without touching the consumers.)
//  - FAIL-SAFE: invalid tier-map budget config is DROPPED + warned, NEVER thrown — a misconfigured
//    tier-map turnBudget must not break dispatch.
//  - enforcement levels are HONEST about what our process-mode spawn can actually do:
//      turn/tool = "nudge"  (prompt-injected at launch; the hard kill/block needs the timeoutMs
//                            wrapper / child instrumentation, both deferred — see PORT-PLAN §①).
//      usage     = "gate"   only when a hard limit exists (blocks LATER dispatches; never the
//                            running one; no reservation model).
//  - Conservative policy: a turn/tool budget on a MUTATION (non-read-only) category ⇒ WARNING
//    (not a block — operator choice), citing why hard-capping workers is risky.

import type {
  CostSummary,
  ResolvedToolBudget,
  ResolvedTurnBudget,
  UsageBudgetConfig,
  UsageBudgetState,
} from "./types.ts";
import { appendTurnBudgetSystemPrompt, resolveTurnBudgetConfig } from "./turn-budget.ts";
import {
  appendToolBudgetSystemPrompt,
  validateToolBudgetConfig,
} from "./tool-budget.ts";
import { usageBudgetState, validateUsageBudgetConfig } from "./usage-budget.ts";

export interface BudgetEnforcement {
  /** "nudge" = prompt-injected at launch. Hard kill needs the timeoutMs wrapper (deferred). */
  turn: "none" | "nudge";
  /** "nudge" = prompt-injected. Hard block needs child-side instrumentation we don't have. */
  tool: "none" | "nudge";
  /** "gate" = pre-launch gate blocks LATER dispatches when a hard limit is exhausted. */
  usage: "none" | "gate";
}

export interface ResolvedBudgets {
  turnBudget?: ResolvedTurnBudget;
  toolBudget?: ResolvedToolBudget;
  usageBudget?: UsageBudgetConfig;
  enforcement: BudgetEnforcement;
  /** Conservative-policy warnings (e.g. hard budget on a mutation category, or invalid config). */
  warnings: string[];
}

export interface ResolveBudgetsInput {
  category: string;
  /** Injected read-only set (source of truth in tier-map.ts). Mutation = not in this set. */
  readOnlyCategories: ReadonlySet<string>;
  /** Raw tier-map turn-budget default for this category (validated; dropped + warned on error). */
  tierTurnBudget?: unknown;
  /** Raw tier-map tool-budget default for this category (validated; dropped + warned on error). */
  tierToolBudget?: unknown;
  /** Session-level usage budget (soft-only default per Q-W2; hard = caller/config opt-in). */
  usageBudget?: unknown;
}

/** A usage budget gates only if at least one metric sets a `hard` limit. Soft-only ⇒ never gates. */
export function hasUsageHardLimit(usageBudget: UsageBudgetConfig | undefined): boolean {
  return !!(
    usageBudget &&
    (usageBudget.tokens?.hard !== undefined || usageBudget.costUsd?.hard !== undefined)
  );
}

/**
 * Resolve the effective budgets for a dispatch. Pure: no spawn, no side effects.
 * Invalid inputs are dropped + warned (fail-safe), never thrown.
 */
export function resolveBudgets(input: ResolveBudgetsInput): ResolvedBudgets {
  const warnings: string[] = [];
  const isReadOnly = input.readOnlyCategories.has(input.category);

  // turn — fail-safe validation.
  let turnBudget: ResolvedTurnBudget | undefined;
  if (input.tierTurnBudget !== undefined) {
    const r = resolveTurnBudgetConfig(input.tierTurnBudget, `tier-map.${input.category}.turnBudget`);
    if (r.error) warnings.push(r.error);
    else turnBudget = r.turnBudget;
  }

  // tool — fail-safe validation.
  let toolBudget: ResolvedToolBudget | undefined;
  if (input.tierToolBudget !== undefined) {
    const r = validateToolBudgetConfig(input.tierToolBudget, `tier-map.${input.category}.toolBudget`);
    if (r.error) warnings.push(r.error);
    else toolBudget = r.budget;
  }

  // usage — session-level; fail-safe validation.
  let usageBudget: UsageBudgetConfig | undefined;
  if (input.usageBudget !== undefined) {
    const r = validateUsageBudgetConfig(input.usageBudget, "usageBudget");
    if (r.error) warnings.push(r.error);
    else usageBudget = r.budget;
  }

  // Conservative policy: a turn/tool budget on a MUTATION category risks blocking read/search
  // tools the worker needs mid-implementation. Warn (do not block — operator choice).
  if (!isReadOnly && (turnBudget || toolBudget)) {
    warnings.push(
      `Budget set on mutation category '${input.category}'. The conservative orchestration policy ` +
        `cautions against hard turn/tool caps on implementation workers — they can block read/search ` +
        `tools mid-work, and neither turns nor tool-counts measure whether a slice is buildable or ` +
        `safe to hand off. (turn/tool enforcement is prompt-nudge only in process mode.)`,
    );
  }

  return {
    ...(turnBudget ? { turnBudget } : {}),
    ...(toolBudget ? { toolBudget } : {}),
    ...(usageBudget ? { usageBudget } : {}),
    enforcement: {
      turn: turnBudget ? "nudge" : "none",
      tool: toolBudget ? "nudge" : "none",
      usage: hasUsageHardLimit(usageBudget) ? "gate" : "none",
    },
    warnings,
  };
}

/** Inject turn/tool launch nudges into a system prompt. Applied to BOTH primary + fallback spawns.
 *  Preserves `undefined` when no nudge applies (so spawn's --append-system-prompt stays absent). */
export function appendBudgetNudges(
  systemPrompt: string | undefined,
  budgets: ResolvedBudgets | undefined,
): string | undefined {
  if (!budgets || (!budgets.turnBudget && !budgets.toolBudget)) return systemPrompt;
  let out = systemPrompt ?? "";
  if (budgets.turnBudget) out = appendTurnBudgetSystemPrompt(out, budgets.turnBudget);
  if (budgets.toolBudget) out = appendToolBudgetSystemPrompt(out, budgets.toolBudget);
  return out;
}

/** Compute the usage-budget state against cumulative session totals (for the pre-launch gate). */
export function budgetUsageState(
  budgets: ResolvedBudgets | undefined,
  totals: CostSummary | undefined,
): UsageBudgetState | undefined {
  return usageBudgetState(budgets?.usageBudget, totals);
}
