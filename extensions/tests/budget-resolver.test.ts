// extensions/tests/budget-resolver.test.ts — budget resolution + enforcement-honesty tests (PORT-PLAN §① wiring).
// Run: node --experimental-strip-types budget-resolver.test.ts   (from extensions/tests/)
//
// Proves the wiring-layer invariants:
//   (1) CONSERVATIVE POLICY — a turn/tool budget on a MUTATION category ⇒ WARNING; on a read-only
//       category ⇒ no warning. A future default that silently budgets a writer breaks this.
//   (2) ENFORCEMENT HONESTY — enforcement levels reflect what process-mode can actually do:
//       turn/tool = "nudge" only; usage = "gate" only when a hard limit exists (soft-only never gates).
//   (3) FAIL-SAFE RESOLUTION — invalid tier-map budget config is dropped + warned, never thrown.
//   (4) NUDGE INJECTION — appendBudgetNudges preserves undefined when no budget applies (so spawn's
//       --append-system-prompt stays absent for no-budget dispatches).
import {
  resolveBudgets,
  appendBudgetNudges,
  budgetUsageState,
  hasUsageHardLimit,
} from "../budgets/index.ts";

const READ_ONLY = new Set(["quick", "research", "git-commit-message"]);

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

// ── (1) conservative policy ─────────────────────────────────────────────────────
const roBudgets = resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY, tierTurnBudget: { maxTurns: 12 } });
check("read-only + turnBudget ⇒ enforcement.turn = nudge", roBudgets.enforcement.turn === "nudge");
check("read-only + turnBudget ⇒ NO conservative warning", roBudgets.warnings.length === 0);
check("read-only turnBudget resolved (maxTurns 12)", roBudgets.turnBudget?.maxTurns === 12);

const writerBudgets = resolveBudgets({ category: "deep", readOnlyCategories: READ_ONLY, tierTurnBudget: { maxTurns: 10 } });
check("writer + turnBudget ⇒ turnBudget still resolved", writerBudgets.turnBudget?.maxTurns === 10);
check("writer + turnBudget ⇒ conservative WARNING fired", writerBudgets.warnings.some((w) => w.includes("mutation category 'deep'")));

const writerToolBudgets = resolveBudgets({ category: "visual-engineering", readOnlyCategories: READ_ONLY, tierToolBudget: { hard: 30 } });
check("writer + toolBudget ⇒ conservative WARNING fired", writerToolBudgets.warnings.some((w) => w.includes("visual-engineering")));
check("writer + toolBudget ⇒ enforcement.tool = nudge", writerToolBudgets.enforcement.tool === "nudge");

const noBudgetWriter = resolveBudgets({ category: "deep", readOnlyCategories: READ_ONLY });
check("writer with NO budget ⇒ no warning (dormant)", noBudgetWriter.warnings.length === 0);

// ── (2) enforcement honesty ─────────────────────────────────────────────────────
check("no budgets ⇒ enforcement all none", resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY }).enforcement.turn === "none" && resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY }).enforcement.tool === "none" && resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY }).enforcement.usage === "none");
check("no usageBudget ⇒ enforcement.usage = none (gate is opt-in)", resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY }).enforcement.usage === "none");
check("usageBudget with hard tokens ⇒ enforcement.usage = gate", resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY, usageBudget: { tokens: { soft: 100, hard: 1000 } } }).enforcement.usage === "gate");
check("usageBudget with hard cost only ⇒ enforcement.usage = gate", resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY, usageBudget: { costUsd: { hard: 5 } } }).enforcement.usage === "gate");

// ── (3) fail-safe resolution ────────────────────────────────────────────────────
const badTurn = resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY, tierTurnBudget: { maxTurns: 0 } });
check("invalid tier turnBudget (maxTurns 0) ⇒ dropped (no turnBudget)", badTurn.turnBudget === undefined);
check("invalid tier turnBudget ⇒ enforcement.turn = none", badTurn.enforcement.turn === "none");
check("invalid tier turnBudget ⇒ warning emitted (not thrown)", badTurn.warnings.some((w) => w.includes("maxTurns")));

const badTool = resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY, tierToolBudget: { soft: 10, hard: 5 } });
check("invalid tier toolBudget (soft>hard) ⇒ dropped", badTool.toolBudget === undefined);
check("invalid tier toolBudget ⇒ warning emitted", badTool.warnings.some((w) => w.includes("soft")));

const badUsage = resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY, usageBudget: { bogus: 1 } });
check("invalid usageBudget ⇒ dropped (no usageBudget)", badUsage.usageBudget === undefined);
check("invalid usageBudget ⇒ warning emitted", badUsage.warnings.some((w) => w.includes("usageBudget")));

// ── (4) nudge injection ─────────────────────────────────────────────────────────
check("appendBudgetNudges: undefined budgets ⇒ undefined preserved", appendBudgetNudges(undefined, undefined) === undefined);
check("appendBudgetNudges: defined prompt, no budgets ⇒ prompt unchanged", appendBudgetNudges("hello", undefined) === "hello");
check("appendBudgetNudges: no turn/tool ⇒ undefined preserved (no spurious prompt)", appendBudgetNudges(undefined, resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY })) === undefined);
const nudged = appendBudgetNudges("base", resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY, tierTurnBudget: { maxTurns: 5 } }));
check("appendBudgetNudges: turnBudget ⇒ Turn budget block appended", typeof nudged === "string" && nudged.includes("Turn budget") && nudged.startsWith("base"));

// ── hasUsageHardLimit + budgetUsageState ────────────────────────────────────────
check("hasUsageHardLimit: undefined ⇒ false", hasUsageHardLimit(undefined) === false);
check("hasUsageHardLimit: hard tokens ⇒ true", hasUsageHardLimit({ tokens: { hard: 100 } }) === true);

const gateNone = budgetUsageState(resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY, usageBudget: { tokens: { hard: 1000 } } }), { inputTokens: 100, outputTokens: 0, costUsd: 0 });
check("budgetUsageState: under hard ⇒ not exhausted", gateNone?.exhausted === false);
const gateHit = budgetUsageState(resolveBudgets({ category: "quick", readOnlyCategories: READ_ONLY, usageBudget: { tokens: { hard: 1000 } } }), { inputTokens: 1100, outputTokens: 0, costUsd: 0 });
check("budgetUsageState: over hard ⇒ exhausted, reason tokens", gateHit?.exhausted === true && gateHit?.reason === "tokens");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
