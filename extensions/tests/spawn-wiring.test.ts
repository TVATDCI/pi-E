// extensions/tests/spawn-wiring.test.ts — budget gate + shared session-state wiring-contract tests.
// Run: node --experimental-strip-types spawn-wiring.test.ts   (from extensions/tests/)
//
// Tests the COMPOSITION the dispatch (index.ts) + run_chain (chain-runner.ts) wiring rely on,
// WITHOUT spawning pi or importing spawn.ts (which has external @earendil-works deps). Covers:
//   (1) session-state.accumulateUsage — the shared accumulator both surfaces mutate.
//   (2) the gate flow — resolveBudgets(hard) → budgetUsageState → not-exhausted under limit →
//       exhausted after accumulate crosses hard (mirrors the index.ts/chain-runner gate logic).
//   (3) consistency — the no-budget DEFAULT path can never exhaust (gate cannot fire).
import { accumulateUsage, sessionUsage } from "../orchestration-engine/session-state.ts";
import { resolveBudgets, budgetUsageState } from "../budgets/index.ts";

const READ_ONLY = new Set(["quick", "research", "git-commit-message"]);
// Reset the shared singleton — tests share one process; isolate from any prior accumulation.
sessionUsage.inputTokens = 0;
sessionUsage.outputTokens = 0;
sessionUsage.costUsd = 0;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}`);
  }
}

// ── (1) session-state.accumulateUsage ────────────────────────────────────────────
accumulateUsage(undefined);
check("accumulateUsage(undefined) is a no-op (no throw, no change)", sessionUsage.inputTokens === 0);
accumulateUsage({ input: 100, output: 50, cost: 0.01 });
check("accumulateUsage adds input tokens", sessionUsage.inputTokens === 100);
check("accumulateUsage adds output tokens", sessionUsage.outputTokens === 50);
check("accumulateUsage adds cost", Math.abs(sessionUsage.costUsd - 0.01) < 1e-9);
accumulateUsage({ input: 200, output: 0, cost: 0.02 });
check("accumulateUsage accumulates across calls (input)", sessionUsage.inputTokens === 300);
check("accumulateUsage accumulates across calls (cost)", Math.abs(sessionUsage.costUsd - 0.03) < 1e-9);

// ── (2) gate flow (mirrors index.ts + chain-runner.ts) ───────────────────────────
const hardBudgets = resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY, usageBudget: { tokens: { hard: 1000 } } });
check("hard usageBudget ⇒ enforcement.usage = gate", hardBudgets.enforcement.usage === "gate");
check("under hard (300 < 1000) ⇒ not exhausted", budgetUsageState(hardBudgets, sessionUsage)?.exhausted === false);
accumulateUsage({ input: 800, output: 0, cost: 0 }); // now 1100 tokens > 1000 hard
const hit = budgetUsageState(hardBudgets, sessionUsage);
check("over hard ⇒ exhausted", hit?.exhausted === true);
check("over hard ⇒ reason = tokens", hit?.reason === "tokens");

// ── (3) consistency: no-budget DEFAULT path can never exhaust ────────────────────
const noBudget = resolveBudgets({ category: "deep", readOnlyCategories: READ_ONLY });
check("no usageBudget ⇒ budgetUsageState undefined (gate cannot fire by default)", budgetUsageState(noBudget, sessionUsage) === undefined);

// ── cost-based gate ──────────────────────────────────────────────────────────────
sessionUsage.inputTokens = 0;
sessionUsage.outputTokens = 0;
sessionUsage.costUsd = 0;
const costBudgets = resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY, usageBudget: { costUsd: { hard: 0.05 } } });
accumulateUsage({ input: 0, output: 0, cost: 0.06 });
check("over cost hard ⇒ exhausted, reason costUsd", budgetUsageState(costBudgets, sessionUsage)?.reason === "costUsd");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
