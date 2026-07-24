// Seed test for routing-stats.ts (Decision 0004). Pure logic, no pi runtime.
// Run: node --experimental-strip-types test-routing-stats.ts
import { aggregateDispatchLog, quotaMarker } from "./routing-stats.ts";
import type { DispatchLogEntry } from "./routing-stats.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

// --- empty ---
const empty = aggregateDispatchLog([], { peak: false, promo: true });
check("empty: n=0, no flags", empty.n === 0 && empty.flags.length === 0);

// --- seeded: mirrors the real probe findings (builder overrides, deep fails) ---
const seed: DispatchLogEntry[] = [
  { category: "quick", modelFlag: "zai-coding-cn/glm-4.5-air", source: "tier-map", agent: null, outcome: "done", elapsedMs: 3000 },
  { category: "quick", modelFlag: "zai-coding-cn/glm-4.5-air", source: "tier-map", agent: null, outcome: "done", elapsedMs: 2500 },
  { category: "quick", modelFlag: "zai-coding-cn/glm-4.5-air", source: "tier-map", agent: null, outcome: "done", elapsedMs: 4000 },
  { category: "deep", modelFlag: "zai-coding-cn/glm-5.2", source: "persona-override", agent: "builder", outcome: "error", elapsedMs: 1000 },
  { category: "deep", modelFlag: "zai-coding-cn/glm-5.2", source: "persona-override", agent: "builder", outcome: "error", elapsedMs: 1100 },
  { category: "deep", modelFlag: "zai-coding-cn/glm-5.2", source: "persona-override", agent: "builder", outcome: "done", elapsedMs: 90000 },
  { category: "git-commit-message", modelFlag: "zai-coding-cn/glm-5.2", source: "persona-override", agent: "builder", outcome: "done", elapsedMs: 41000 },
  { category: "unspecified-high", modelFlag: "zai-coding-cn/glm-5.2", source: "tier-map", agent: null, outcome: "done", elapsedMs: 22000 },
  { category: "git-commit-message", modelFlag: "opencode/deepseek-v4-flash-free", source: "tier-map", agent: null, outcome: "done", elapsedMs: 26000 },
];
const s = aggregateDispatchLog(seed, { peak: false, promo: true });
check("seeded: n=9", s.n === 9);
check("seeded: fails=2", s.fails === 2);
check("seeded: overrides=4", s.overrides === 4);
check("flag: deep fails 67% (2/3)", s.flags.some((f) => f.includes("deep fails")));
check("flag: builder overrides 100%", s.flags.some((f) => f.includes("builder overrides 100%")));
check("flag: high override rate 44%", s.flags.some((f) => f.includes("high override rate")));
check("no false flag on clean quick", !s.flags.some((f) => f.includes("quick fails")));

// --- quota marker matrix ---
check("quota: opencode = FREE", quotaMarker("opencode/deepseek-v4-flash-free", false, true) === "FREE");
check("quota: glm-5.2 promo off-peak = 1×", quotaMarker("zai-coding-cn/glm-5.2", false, true) === "1×");
check("quota: glm-5.2 post-promo = 2×", quotaMarker("zai-coding-cn/glm-5.2", false, false) === "2×");
check("quota: glm-5.2 peak = 3×", quotaMarker("zai-coding-cn/glm-5.2", true, true) === "3×");
check("quota: glm-4.7 always 1×", quotaMarker("zai-coding-cn/glm-4.7", true, false) === "1×");

// --- downshift-unavailable source (F4) ---
const ds = aggregateDispatchLog(
  [
    { category: "git-commit-message", modelFlag: "zai-coding-cn/glm-5.2", source: "downshift-unavailable", downshiftedFrom: "opencode/deepseek-v4-flash-free", agent: null, outcome: "done", elapsedMs: 30000 },
    { category: "quick", modelFlag: "zai-coding-cn/glm-4.5-air", source: "tier-map", agent: null, outcome: "done", elapsedMs: 2000 },
  ],
  { peak: false, promo: true },
);
check("downshift: n=2", ds.n === 2);
check("downshift flag fires", ds.flags.some((f) => f.includes("downshifted")));

console.log("\n=== formatted table (visual check) ===");
console.log(s.lines.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
