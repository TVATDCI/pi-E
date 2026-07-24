// Tier 1 test for budget.ts. Run: node --experimental-strip-types test-budget.ts
import { applyBudget, estimateTokens, DEFAULT_TOKEN_BUDGET } from "./budget.ts";
import type { MemoryRecord } from "./schema.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}

function rec(key: string, valueLen: number): MemoryRecord {
  return {
    schemaVersion: 1, scope: "global", category: "fact", key,
    value: "x".repeat(valueLen), provenance: "operator", turn: 0, recordedAt: 0,
  };
}

// --- estimateTokens ---
check("estimateTokens: 8 chars -> 2 tokens", estimateTokens("abcdefgh") === 2);
check("estimateTokens: 7 chars -> 2 tokens (ceil)", estimateTokens("abcdefg") === 2);
check("estimateTokens: empty -> 0", estimateTokens("") === 0);
check("DEFAULT_TOKEN_BUDGET is 2000", DEFAULT_TOKEN_BUDGET === 2000);

// --- under budget: keep all ---
// 3 records x 8-char value (2 tokens each) = 6 tokens, budget 10 -> keep all
const under = applyBudget([rec("a", 8), rec("b", 8), rec("c", 8)], 10);
check("under budget: keeps all 3", under.kept.length === 3 && under.cut.length === 0);
check("under budget: estimatedTokens = 6", under.estimatedTokens === 6);

// --- over budget: cut lowest-rank first ---
// 5 records x 2 tokens = 10, budget 6 -> keep 3, cut 2
const over = applyBudget([rec("a", 8), rec("b", 8), rec("c", 8), rec("d", 8), rec("e", 8)], 6);
check("over budget: keeps 3", over.kept.length === 3);
check("over budget: cuts 2", over.cut.length === 2);
check("over budget: kept are first 3 in rank order",
  JSON.stringify(over.kept.map((r) => r.key)) === JSON.stringify(["a", "b", "c"]));
check("over budget: cut are last 2 in rank order",
  JSON.stringify(over.cut.map((r) => r.key)) === JSON.stringify(["d", "e"]));
check("over budget: estimatedTokens = 6", over.estimatedTokens === 6);

// --- boundary: exact fit ---
// budget 6, 3 records x 2 tokens = 6 -> all fit (<=)
const exact = applyBudget([rec("a", 8), rec("b", 8), rec("c", 8)], 6);
check("boundary: exact fit keeps all", exact.kept.length === 3 && exact.cut.length === 0);

// --- one over the boundary ---
const oneOver = applyBudget([rec("a", 8), rec("b", 8), rec("c", 8)], 5);
check("boundary: 6 tokens vs budget 5 keeps 2 cuts 1", oneOver.kept.length === 2 && oneOver.cut.length === 1);

// --- custom costFn ---
const customCost = applyBudget([rec("a", 8), rec("b", 8)], 100, (_r) => 1);
check("custom costFn honored (budget 100 x cost 1 keeps 2)", customCost.kept.length === 2 && customCost.estimatedTokens === 2);

// --- empty ---
const empty = applyBudget([], 10);
check("empty input: kept 0, cut 0", empty.kept.length === 0 && empty.cut.length === 0);
check("empty input: estimatedTokens 0", empty.estimatedTokens === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
