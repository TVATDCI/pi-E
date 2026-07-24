// Tier 1 test for ranker.ts. Run: node --experimental-strip-types test-ranker.ts
import { rankForInjection } from "./ranker.ts";
import type { MemoryRecord } from "./schema.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}

function rec(
  category: MemoryRecord["category"],
  key: string,
  provenance: MemoryRecord["provenance"],
  recordedAt: number,
): MemoryRecord {
  return { schemaVersion: 1, scope: "global", category, key, value: "v", provenance, turn: 0, recordedAt };
}

const keysOf = (rs: MemoryRecord[]) => rs.map((r) => r.key);

// --- category priority ---
const mixedCat = [
  rec("fact", "f", "operator", 100),
  rec("preference", "p", "operator", 100),
  rec("convention", "cv", "operator", 100),
  rec("decision", "d", "operator", 100),
  rec("constraint", "c", "operator", 100),
];
check("category order: constraint>decision>convention>preference>fact",
  JSON.stringify(keysOf(rankForInjection(mixedCat))) === JSON.stringify(["c", "d", "cv", "p", "f"]));

// --- provenance within category ---
const mixedProv = [
  rec("constraint", "inferred_first", "inferred", 100),
  rec("constraint", "operator_second", "operator", 50),
];
check("provenance: operator before inferred within category",
  JSON.stringify(keysOf(rankForInjection(mixedProv))) === JSON.stringify(["operator_second", "inferred_first"]));

// --- recency within category+provenance (newest first) ---
const mixedRecency = [
  rec("fact", "old", "operator", 100),
  rec("fact", "newest", "operator", 300),
  rec("fact", "mid", "operator", 200),
];
check("recency: newest recordedAt first within bucket",
  JSON.stringify(keysOf(rankForInjection(mixedRecency))) === JSON.stringify(["newest", "mid", "old"]));

// --- combined: category dominates, then provenance, then recency ---
const combined = [
  rec("fact", "f_inf_new", "inferred", 900),     // fact+inferred, very new -> still last bucket
  rec("constraint", "c_inf", "inferred", 10),
  rec("constraint", "c_op", "operator", 5),
  rec("decision", "d_op", "operator", 1),
];
check("combined: c_op, c_inf, d_op, f_inf_new",
  JSON.stringify(keysOf(rankForInjection(combined))) === JSON.stringify(["c_op", "c_inf", "d_op", "f_inf_new"]));

// --- does not mutate input ---
const input = [rec("fact", "a", "operator", 1), rec("constraint", "b", "operator", 2)];
const inputBefore = JSON.stringify(input);
rankForInjection(input);
check("pure: input not mutated", JSON.stringify(input) === inputBefore);

// --- empty ---
check("empty input -> empty output", rankForInjection([]).length === 0);

// --- single ---
check("single record preserved", rankForInjection([rec("fact", "solo", "operator", 1)]).length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
